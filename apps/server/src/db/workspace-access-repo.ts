import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from './client.js'
import { instance, session, user, workspaceGrant, workspaceSession } from './schema.js'

export const hashWorkspaceSecret = (value: string): string => createHash('sha256').update(value).digest('hex')
const newSecret = () => randomBytes(32).toString('base64url')
const validSecret = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value)

// Recheck the original identity on every request; a workspace token cannot outlive it.
function liveIdentity(instanceId: string, sessionId: string) {
  return and(
    eq(instance.id, instanceId), eq(session.id, sessionId),
    eq(instance.ownerId, session.userId), isNull(instance.deletedAt),
    eq(instance.status, 'running'), gt(session.expiresAt, sql`now()`),
    isNull(session.impersonatedBy), eq(user.banned, false),
  )
}

export async function issueWorkspaceGrant(db: Db, input: {
  instanceId: string; sessionId: string; state: string; callbackUrl: string
}): Promise<string | undefined> {
  if (!validSecret(input.state)) return undefined
  const code = newSecret()
  const rows = await db.insert(workspaceGrant).select(
    db.select({
      codeHash: sql<string>`${hashWorkspaceSecret(code)}`.as('code_hash'),
      stateHash: sql<string>`${hashWorkspaceSecret(input.state)}`.as('state_hash'),
      instanceId: instance.id,
      sessionId: session.id,
      callbackUrl: sql<string>`${input.callbackUrl}`.as('callback_url'),
      expiresAt: sql<Date>`now() + interval '60 seconds'`.as('expires_at'),
    }).from(instance).innerJoin(session, eq(session.userId, instance.ownerId))
      .innerJoin(user, eq(user.id, session.userId))
      .where(liveIdentity(input.instanceId, input.sessionId)),
  ).returning({ codeHash: workspaceGrant.codeHash })
  return rows.length ? code : undefined
}

export async function exchangeWorkspaceGrant(db: Db, input: {
  code: string; state: string; instanceId: string; callbackUrl: string
}): Promise<string | undefined> {
  if (!validSecret(input.code) || !validSecret(input.state)) return undefined
  return db.transaction(async tx => {
    // DELETE RETURNING serializes concurrent exchanges; only one can mint a session.
    const [grant] = await tx.delete(workspaceGrant).where(and(
      eq(workspaceGrant.codeHash, hashWorkspaceSecret(input.code)),
      eq(workspaceGrant.stateHash, hashWorkspaceSecret(input.state)),
      eq(workspaceGrant.instanceId, input.instanceId),
      eq(workspaceGrant.callbackUrl, input.callbackUrl),
      gt(workspaceGrant.expiresAt, sql`now()`),
    )).returning()
    if (!grant) return undefined
    const token = newSecret()
    const rows = await tx.insert(workspaceSession).select(
      tx.select({
        tokenHash: sql<string>`${hashWorkspaceSecret(token)}`.as('token_hash'),
        instanceId: instance.id,
        sessionId: session.id,
        expiresAt: sql<Date>`least(${session.expiresAt}, now() + interval '12 hours')`.as('expires_at'),
      }).from(instance).innerJoin(session, eq(session.userId, instance.ownerId))
        .innerJoin(user, eq(user.id, session.userId))
        .where(liveIdentity(grant.instanceId, grant.sessionId)),
    ).returning({ tokenHash: workspaceSession.tokenHash })
    return rows.length ? token : undefined
  })
}

export async function resolveWorkspaceSession(db: Db, token: string, instanceId: string): Promise<string | undefined> {
  if (!validSecret(token)) return undefined
  const [row] = await db.select({ userId: session.userId }).from(workspaceSession)
    .innerJoin(session, eq(session.id, workspaceSession.sessionId))
    .innerJoin(instance, eq(instance.id, workspaceSession.instanceId))
    .innerJoin(user, eq(user.id, session.userId))
    .where(and(
      eq(workspaceSession.tokenHash, hashWorkspaceSecret(token)),
      eq(instance.id, instanceId), eq(instance.ownerId, session.userId),
      isNull(instance.deletedAt), eq(instance.status, 'running'),
      gt(workspaceSession.expiresAt, sql`now()`), gt(session.expiresAt, sql`now()`),
      isNull(session.impersonatedBy), eq(user.banned, false),
    )).limit(1)
  return row?.userId
}

export async function deleteExpiredWorkspaceAccess(db: Db): Promise<void> {
  await db.delete(workspaceGrant).where(lt(workspaceGrant.expiresAt, sql`now()`))
  await db.delete(workspaceSession).where(lt(workspaceSession.expiresAt, sql`now()`))
}
