import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { registerWorkspaceAuthorization } from './workspace-authorization.js'

describe('console workspace authorization', () => {
  it('returns a non-cacheable unavailable response when the identity service fails', async () => {
    const app = Fastify()
    const issue = vi.fn(async () => 'unused')
    registerWorkspaceAuthorization(app, {
      consoleOrigin: 'https://console.example.com', workspaceOrigin: slug => `https://${slug}.example.com`,
      resolveSession: async () => { throw new Error('database unavailable') }, issue,
    })
    try {
      const response = await app.inject({ url: `/api/workspace/authorize?slug=alice&state=${'s'.repeat(43)}`, headers: { host: 'console.example.com' } })
      expect(response.statusCode).toBe(503)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['retry-after']).toBe('5')
      expect(response.body).not.toContain('database')
      expect(issue).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
  const state = 's'.repeat(43)
  async function setup(sessionId: string | undefined = 'session', allowed = true) {
    const app = Fastify()
    const issue = vi.fn(async () => allowed ? 'code' : undefined)
    registerWorkspaceAuthorization(app, {
      consoleOrigin: 'https://console.example.com', workspaceOrigin: slug => `https://${slug}.example.com`,
      resolveSession: async () => sessionId, issue,
    })
    return { app, issue }
  }
  it('derives the callback from the instance, ignoring supplied redirect destinations', async () => {
    const { app, issue } = await setup()
    try {
      const res = await app.inject({ url: `/api/workspace/authorize?slug=alice&state=${state}&redirect_uri=https://evil.test`, headers: { host: 'console.example.com' } })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe(`https://alice.example.com/_dsh_cloud/callback?code=code&state=${state}`)
      expect(issue).toHaveBeenCalledWith({ slug: 'alice', state, sessionId: 'session', callbackUrl: 'https://alice.example.com/_dsh_cloud/callback' })
      expect(res.headers['cache-control']).toBe('no-store')
    } finally { await app.close() }
  })
  it('requires the console host and a valid browser transaction', async () => {
    const { app, issue } = await setup()
    try {
      expect((await app.inject({ url: `/api/workspace/authorize?slug=alice&state=${state}`, headers: { host: 'alice.example.com' } })).statusCode).toBe(403)
      expect((await app.inject({ url: '/api/workspace/authorize?slug=alice&state=bad', headers: { host: 'console.example.com' } })).statusCode).toBe(400)
      expect(issue).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
  it('refuses non-owner authorization', async () => {
    const { app } = await setup('session', false)
    try {
      expect((await app.inject({ url: `/api/workspace/authorize?slug=alice&state=${state}`, headers: { host: 'console.example.com' } })).statusCode).toBe(403)
    } finally { await app.close() }
  })
})
