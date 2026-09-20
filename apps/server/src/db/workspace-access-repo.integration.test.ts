import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type Docker from 'dockerode'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDocker } from '../docker/client.js'
import { createDb } from './client.js'
import { instance, session, user, workspaceGrant, workspaceSession } from './schema.js'
import { deleteExpiredWorkspaceAccess, exchangeWorkspaceGrant, hashWorkspaceSecret, issueWorkspaceGrant, resolveWorkspaceSession } from './workspace-access-repo.js'

describe.runIf(process.env.DSH_SECURITY_INTEGRATION === '1')('workspace credential database boundary', () => {
  let container: Docker.Container | undefined
  let database: ReturnType<typeof createDb>
  beforeAll(async () => {
    const password = randomUUID()
    container = await createDocker().createContainer({
      Image: 'postgres:16-alpine', Env: [`POSTGRES_PASSWORD=${password}`],
      ExposedPorts: { '5432/tcp': {} }, HostConfig: {
        PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
        Tmpfs: { '/var/lib/postgresql/data': 'rw,size=512m' },
      },
    })
    await container.start()
    const port = (await container.inspect()).NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort
    if (!port) throw new Error('Missing test database port')
    database = createDb(`postgres://postgres:${password}@127.0.0.1:${port}/postgres`)
    for (let attempt = 0; ; attempt++) {
      try { await database.client`select 1`; break } catch (error) {
        if (attempt >= 60) throw error
        await delay(100)
      }
    }
    await migrate(database.db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname })
  }, 60_000)
  afterAll(async () => {
    await database?.client.end()
    await container?.remove({ force: true, v: true })
  })

  async function fixture() {
    const userId = randomUUID(), sessionId = randomUUID(), instanceId = randomUUID()
    const now = new Date()
    await database.db.insert(user).values({ id: userId, name: 'test', email: `${userId}@example.test`, emailVerified: false, createdAt: now, updatedAt: now })
    await database.db.insert(session).values({ id: sessionId, userId, token: randomUUID(), createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 3_600_000) })
    await database.db.insert(instance).values({ id: instanceId, ownerId: userId, slug: `w-${instanceId}`, status: 'running', image: 'test', cpus: 1, memoryMb: 256 })
    const input = { sessionId, instanceId, state: randomBytes(32).toString('base64url'), callbackUrl: `https://w-${instanceId}.example.test/_auth/callback` }
    const code = await issueWorkspaceGrant(database.db, input)
    expect(code).toBeDefined()
    return { ...input, code: code!, userId }
  }

  it('enforces bounded statements and remains usable after cancellation', async () => {
    const [settings] = await database.client`select
      current_setting('statement_timeout') as statement,
      current_setting('lock_timeout') as lock,
      current_setting('idle_in_transaction_session_timeout') as idle`
    expect(settings).toEqual({ statement: '15s', lock: '5s', idle: '30s' })
    await expect(database.client`select pg_sleep(30)`).rejects.toMatchObject({ code: '57014' })
    expect((await database.client`select 1 as ready`)[0]?.ready).toBe(1)
  }, 20_000)

  it('atomically exchanges once under concurrency and stores only hashes', async () => {
    const input = await fixture()
    const [grant] = await database.db.select().from(workspaceGrant).where(eq(workspaceGrant.codeHash, hashWorkspaceSecret(input.code)))
    expect(JSON.stringify(grant)).not.toContain(input.code)
    expect(JSON.stringify(grant)).not.toContain(input.state)
    const results = await Promise.all(Array.from({ length: 8 }, () => exchangeWorkspaceGrant(database.db, input)))
    const tokens = results.filter((token): token is string => token !== undefined)
    expect(tokens).toHaveLength(1)
    expect(await resolveWorkspaceSession(database.db, tokens[0]!, input.instanceId)).toBe(input.userId)
    const [stored] = await database.db.select().from(workspaceSession).where(eq(workspaceSession.tokenHash, hashWorkspaceSecret(tokens[0]!)))
    expect(stored).toBeDefined()
    expect(JSON.stringify(stored)).not.toContain(tokens[0])
    expect(await resolveWorkspaceSession(database.db, tokens[0]!, randomUUID())).toBeUndefined()
  })

  it('rejects wrong browser transaction, callback and instance without consuming the grant', async () => {
    const input = await fixture()
    for (const override of [{ state: randomBytes(32).toString('base64url') }, { callbackUrl: 'https://evil.test/' }, { instanceId: randomUUID() }]) {
      expect(await exchangeWorkspaceGrant(database.db, { ...input, ...override })).toBeUndefined()
    }
    expect(await exchangeWorkspaceGrant(database.db, input)).toBeDefined()
    expect(await exchangeWorkspaceGrant(database.db, input)).toBeUndefined()
  })

  it.each(['banned', 'expired', 'impersonated', 'deleted', 'stopped', 'changed-owner'] as const)('rejects %s identities before grant exchange and during access', async mode => {
    const input = await fixture()
    const token = await exchangeWorkspaceGrant(database.db, input)
    const code = await issueWorkspaceGrant(database.db, input)
    expect(code).toBeDefined()
    if (mode === 'banned') await database.db.update(user).set({ banned: true }).where(eq(user.id, input.userId))
    if (mode === 'expired') await database.db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.id, input.sessionId))
    if (mode === 'impersonated') await database.db.update(session).set({ impersonatedBy: 'admin' }).where(eq(session.id, input.sessionId))
    if (mode === 'deleted') await database.db.update(instance).set({ deletedAt: new Date() }).where(eq(instance.id, input.instanceId))
    if (mode === 'stopped') await database.db.update(instance).set({ status: 'stopped' }).where(eq(instance.id, input.instanceId))
    if (mode === 'changed-owner') {
      const other = await fixture()
      await database.db.update(instance).set({ ownerId: other.userId }).where(eq(instance.id, input.instanceId))
    }
    expect(await issueWorkspaceGrant(database.db, input)).toBeUndefined()
    expect(await exchangeWorkspaceGrant(database.db, { ...input, code: code! })).toBeUndefined()
    expect(await resolveWorkspaceSession(database.db, token!, input.instanceId)).toBeUndefined()
  })

  it('rejects expired grants and cascades credentials when the console session is revoked', async () => {
    const input = await fixture()
    await database.db.update(workspaceGrant).set({ expiresAt: new Date(0) }).where(eq(workspaceGrant.codeHash, hashWorkspaceSecret(input.code)))
    expect(await exchangeWorkspaceGrant(database.db, input)).toBeUndefined()
    const code = await issueWorkspaceGrant(database.db, input)
    const token = await exchangeWorkspaceGrant(database.db, { ...input, code: code! })
    await database.db.delete(session).where(eq(session.id, input.sessionId))
    expect(await resolveWorkspaceSession(database.db, token!, input.instanceId)).toBeUndefined()
    expect(await database.db.select().from(workspaceSession).where(eq(workspaceSession.tokenHash, hashWorkspaceSecret(token!)))).toHaveLength(0)
  })

  it('rejects a session belonging to another owner at grant issuance', async () => {
    const alice = await fixture(), bob = await fixture()
    expect(await issueWorkspaceGrant(database.db, { ...alice, sessionId: bob.sessionId })).toBeUndefined()
  })

  it('expires workspace credentials independently and removes only expired records', async () => {
    const expired = await fixture(), live = await fixture()
    const token = await exchangeWorkspaceGrant(database.db, expired)
    await database.db.update(workspaceSession).set({ expiresAt: new Date(0) }).where(eq(workspaceSession.tokenHash, hashWorkspaceSecret(token!)))
    const expiredCode = await issueWorkspaceGrant(database.db, expired)
    await database.db.update(workspaceGrant).set({ expiresAt: new Date(0) }).where(eq(workspaceGrant.codeHash, hashWorkspaceSecret(expiredCode!)))
    expect(await resolveWorkspaceSession(database.db, token!, expired.instanceId)).toBeUndefined()
    await deleteExpiredWorkspaceAccess(database.db)
    expect(await database.db.select().from(workspaceSession).where(eq(workspaceSession.tokenHash, hashWorkspaceSecret(token!)))).toHaveLength(0)
    expect(await database.db.select().from(workspaceGrant).where(eq(workspaceGrant.codeHash, hashWorkspaceSecret(expiredCode!)))).toHaveLength(0)
    expect(await exchangeWorkspaceGrant(database.db, live)).toBeDefined()
  })
})
