import { createServer, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import httpProxy from 'http-proxy'
import { parseString } from 'set-cookie-parser'
import { monitorAccess } from './access-lease.js'
import { authorizationDeadline } from './authorization-deadline.js'
import { authorizationCapacity } from './authorization-capacity.js'
import { beginWorkspaceLogin, completeWorkspaceLogin, WORKSPACE_CALLBACK, type WorkspaceLogin } from './workspace-login.js'
import { decideForwardAuth, instanceSlugFromHost, type ForwardAuthDeps } from './forward-auth.js'

export function filterWorkspaceCookies(values: string[] | undefined): string[] {
  return (values ?? []).filter(value => {
    const parsed = parseString(value, { decodeValues: false })
    // Domain cookies are never needed: each workspace has its own host.
    return parsed !== null && parsed.name.length > 0 && parsed.domain === undefined &&
      !/^(?:__Secure-|__Host-)?dsh_cloud(?:[._]|$)/i.test(parsed.name)
  })
}

export interface WorkspaceGatewayDeps extends ForwardAuthDeps {
  findTargetPort(slug: string): Promise<number | undefined>
  login?: WorkspaceLogin
}

export function createWorkspaceGateway(deps: WorkspaceGatewayDeps) {
  const admit = authorizationCapacity(64)
  const renew = authorizationCapacity(16)
  const login = deps.login ? {
    ...deps.login,
    exchange: (input: Parameters<WorkspaceLogin['exchange']>[0]) => admit(() => deps.login!.exchange(input)),
  } : undefined
  const sockets = new Set<Socket>()
  let closing = false
  const proxy = httpProxy.createProxyServer({ proxyTimeout: 120_000 })
  const sanitize = (response: IncomingMessage) => {
    const cookies = filterWorkspaceCookies(response.headers['set-cookie'])
    if (cookies.length) response.headers['set-cookie'] = cookies
    else delete response.headers['set-cookie']
    delete response.headers['clear-site-data']
    // A hostile backend must not persist authenticated responses in shared caches.
    response.headers['cache-control'] = 'private, no-store'
    response.headers.expires = '0'
    for (const name of ['cdn-cache-control', 'surrogate-control', 'cloudflare-cdn-cache-control']) {
      delete response.headers[name]
    }
    const csp = response.headers['content-security-policy']
    response.headers['content-security-policy'] = [
      ...(Array.isArray(csp) ? csp : csp ? [csp] : []),
      "frame-ancestors 'none'",
    ]
    response.headers['x-frame-options'] = 'DENY'
    response.headers['referrer-policy'] = 'no-referrer'
  }
  proxy.on('proxyRes', sanitize)
  proxy.on('proxyReqWs', request => {
    request.on('upgrade', sanitize)
    request.on('response', sanitize)
  })

  async function authorize(req: IncomingMessage) {
    const host = req.headers.host
    const originalCookie = req.headers.cookie
    const result = await decideForwardAuth({
      host, cookie: req.headers.cookie,
      method: req.method ?? 'GET',
      ...(req.headers.origin === undefined ? {} : { origin: req.headers.origin }),
      originalUrl: `${deps.publicScheme}://${host}${req.url ?? '/'}`,
    }, deps)
    if (result.status !== 200) return { result }
    const slug = instanceSlugFromHost(host, deps.baseDomain)!
    const port = await deps.findTargetPort(slug)
    if (!Number.isInteger(port) || port! < 1 || port! > 65535) {
      return { result: { status: 404 as const } }
    }
    for (const key of Object.keys(req.headers)) {
      if (key.startsWith('x-platform-') || key.startsWith('x-forwarded-') || key === 'forwarded') {
        delete req.headers[key]
      }
    }
    for (const [key, value] of Object.entries(result.headers)) req.headers[key.toLowerCase()] = value
    const check = () => renew(async () => {
      const user = await deps.resolveUserId(originalCookie, slug)
      const instance = await deps.findInstanceBySlug(slug)
      return user !== undefined && instance?.ownerId === user &&
        await deps.findTargetPort(slug) === port
    })
    return { result, target: `http://127.0.0.1:${port}`, check }
  }

  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'private, no-store')
    const slug = instanceSlugFromHost(req.headers.host, deps.baseDomain)
    const origin = `${deps.publicScheme}://${slug}.${deps.baseDomain}`
    if (deps.login && (!slug || req.headers.host !== `${slug}.${deps.baseDomain}`)) {
      res.writeHead(404); res.end(); return
    }
    if (deps.login && req.url?.startsWith('/_dsh_cloud/')) {
      if (req.url.split('?')[0] !== WORKSPACE_CALLBACK) { res.writeHead(404); res.end(); return }
      void completeWorkspaceLogin(req, res, slug!, origin, login!).catch(() => {
        if (!res.destroyed) { res.writeHead(503); res.end() }
      })
      return
    }
    void authorizationDeadline(admit(() => authorize(req))).then(({ result, target, check }) => {
      if (closing || res.destroyed) return
      if (!target) {
        if (result.status === 302 && deps.login) {
          beginWorkspaceLogin(req, res, slug!, deps.login)
          return
        }
        res.writeHead(result.status, result.status === 302 ? { location: result.location } : {})
        res.end()
        return
      }
      const stop = monitorAccess(check!, () => { req.destroy(); res.destroy() })
      res.once('close', stop)
      res.once('finish', stop)
      proxy.web(req, res, { target }, () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
    }).catch(() => { res.writeHead(503); res.end() })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    const slug = instanceSlugFromHost(req.headers.host, deps.baseDomain)
    if (deps.login && (!slug || req.headers.host !== `${slug}.${deps.baseDomain}` || req.url?.startsWith('/_dsh_cloud/'))) {
      socket.end('HTTP/1.1 403 Rejected\r\nConnection: close\r\n\r\n'); return
    }
    void authorizationDeadline(admit(() => authorize(req))).then(({ result, target, check }) => {
      if (closing || socket.destroyed) return
      if (!target) { socket.end(`HTTP/1.1 ${result.status} Rejected\r\nConnection: close\r\n\r\n`); return }
      const stop = monitorAccess(check!, () => socket.destroy())
      socket.once('close', stop)
      proxy.ws(req, socket, head, { target }, () => socket.destroy())
    }).catch(() => socket.destroy())
  })
  server.on('close', () => proxy.close())
  return Object.assign(server, {
    shutdown: () => {
      closing = true
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
      // HTTP server shutdown alone leaves upgraded connections alive.
      for (const socket of sockets) socket.destroy()
      return closed
    },
  })
}
