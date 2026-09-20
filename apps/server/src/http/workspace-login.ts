import { randomBytes, timingSafeEqual } from 'node:crypto'
import { parse, serialize } from 'cookie'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { authorizationDeadline } from './authorization-deadline.js'

export const WORKSPACE_CALLBACK = '/_dsh_cloud/callback'
export const WORKSPACE_AUTHORIZE = '/api/workspace/authorize'
export const workspaceCookieName = (secure: boolean) => `${secure ? '__Host-' : ''}dsh_cloud.workspace`
const transactionCookieName = (secure: boolean) => `${secure ? '__Host-' : ''}dsh_cloud.transaction`
const validState = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value)

export function workspaceToken(cookie: string | undefined, secure: boolean): string | undefined {
  return parse(cookie ?? '')[workspaceCookieName(secure)]
}

export interface WorkspaceLogin {
  consoleOrigin: string
  secure: boolean
  exchange(input: { slug: string; code: string; state: string; callbackUrl: string }): Promise<string | undefined>
}

function cookieOptions(secure: boolean, maxAge: number) {
  return { secure, httpOnly: true, sameSite: 'lax' as const, path: '/', maxAge }
}

function privateResponse(res: ServerResponse) {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
}

function safePath(path: string) {
  return path.startsWith('/') && !path.startsWith('//') && !/[\\\u0000-\u0020\u007f]/.test(path)
}

export function beginWorkspaceLogin(req: IncomingMessage, res: ServerResponse, slug: string, deps: WorkspaceLogin) {
  privateResponse(res)
  if (req.method !== 'GET' || (req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'document')) {
    res.writeHead(401); res.end(); return
  }
  const state = randomBytes(32).toString('base64url')
  const next = safePath(req.url ?? '') && (req.url?.length ?? 0) <= 2048 ? req.url! : '/'
  const transaction = Buffer.from(JSON.stringify({ state, next })).toString('base64url')
  res.setHeader('set-cookie', serialize(transactionCookieName(deps.secure), transaction, cookieOptions(deps.secure, 300)))
  const location = new URL(WORKSPACE_AUTHORIZE, deps.consoleOrigin)
  location.searchParams.set('slug', slug)
  location.searchParams.set('state', state)
  res.writeHead(302, { location: location.toString() }); res.end()
}

export async function completeWorkspaceLogin(req: IncomingMessage, res: ServerResponse, slug: string, origin: string, deps: WorkspaceLogin) {
  privateResponse(res)
  const url = new URL(req.url!, origin)
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''
  let transaction: { state?: unknown; next?: unknown } = {}
  try {
    transaction = JSON.parse(Buffer.from(parse(req.headers.cookie ?? '')[transactionCookieName(deps.secure)] ?? '', 'base64url').toString())
  } catch { /* A missing or malformed browser transaction fails closed. */ }
  if (!transaction || typeof transaction.state !== 'string' || !validState(state) || !validState(transaction.state) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(transaction.state)) ||
      typeof transaction.next !== 'string' || !safePath(transaction.next)) {
    res.writeHead(403); res.end(); return
  }
  const token = await authorizationDeadline(deps.exchange({ slug, code, state, callbackUrl: `${origin}${WORKSPACE_CALLBACK}` }))
  if (res.destroyed) return
  if (!token) { res.writeHead(403); res.end(); return }
  res.setHeader('set-cookie', [
    serialize(workspaceCookieName(deps.secure), token, cookieOptions(deps.secure, 43_200)),
    serialize(transactionCookieName(deps.secure), '', cookieOptions(deps.secure, 0)),
  ])
  res.writeHead(303, { location: transaction.next }); res.end()
}
