import type { FastifyInstance } from 'fastify'
import { InstanceSlugSchema } from '@dsh-cloud/instance-spec'
import { WORKSPACE_AUTHORIZE, WORKSPACE_CALLBACK } from './workspace-login.js'
import { authorizationCapacity } from './authorization-capacity.js'
import { authorizationDeadline } from './authorization-deadline.js'

export interface WorkspaceAuthorizationDeps {
  consoleOrigin: string
  workspaceOrigin(slug: string): string
  resolveSession(cookie: string | undefined): Promise<string | undefined>
  issue(input: { slug: string; sessionId: string; state: string; callbackUrl: string }): Promise<string | undefined>
}

export function registerWorkspaceAuthorization(app: FastifyInstance, deps: WorkspaceAuthorizationDeps) {
  const admit = authorizationCapacity(32)
  app.get(WORKSPACE_AUTHORIZE, async (req, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
    if (req.headers.host !== new URL(deps.consoleOrigin).host) return reply.code(403).send()
    const query = req.query as Record<string, unknown>
    const parsed = InstanceSlugSchema.safeParse(query.slug)
    if (!parsed.success || typeof query.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(query.state)) {
      return reply.code(400).send()
    }
    let sessionId: string | undefined
    let code: string | undefined
    const callbackUrl = `${deps.workspaceOrigin(parsed.data)}${WORKSPACE_CALLBACK}`
    const state = query.state
    try {
      const result = await authorizationDeadline(admit(async () => {
        const identity = await deps.resolveSession(req.headers.cookie)
        return {
          sessionId: identity,
          code: identity ? await deps.issue({ slug: parsed.data, sessionId: identity, state, callbackUrl }) : undefined,
        }
      }))
      sessionId = result.sessionId
      code = result.code
    } catch {
      return reply.code(503).header('retry-after', '5').send()
    }
    if (!sessionId) {
      // Absolute same-origin URL forces a document navigation after login, not a SPA route.
      const next = new URL(WORKSPACE_AUTHORIZE, deps.consoleOrigin)
      next.searchParams.set('slug', parsed.data); next.searchParams.set('state', query.state)
      return reply.redirect(`${deps.consoleOrigin}/login?next=${encodeURIComponent(next.toString())}`)
    }
    if (!code) return reply.code(403).send()
    const location = new URL(callbackUrl)
    location.searchParams.set('code', code); location.searchParams.set('state', query.state)
    return reply.redirect(location.toString())
  })
}
