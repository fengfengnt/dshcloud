import { afterEach, describe, expect, it, vi } from 'vitest'
import { monitorAccess } from './access-lease.js'

afterEach(() => vi.useRealTimers())
describe('stream authorization lease', () => {
  it.each(['revoked', 'failed', 'stalled'])('closes a %s session within 30 seconds', async mode => {
    vi.useFakeTimers()
    const revoke = vi.fn()
    monitorAccess(() => mode === 'stalled' ? new Promise(() => {})
      : mode === 'failed' ? Promise.reject(new Error('offline')) : Promise.resolve(false), revoke)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(revoke).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('renews valid sessions, then revokes after authorization changes', async () => {
    vi.useFakeTimers()
    const check = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const revoke = vi.fn()
    monitorAccess(check, revoke)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(revoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(25_000)
    expect(revoke).toHaveBeenCalledOnce()
  })
  it('cancels pending checks when the stream closes', async () => {
    vi.useFakeTimers()
    const check = vi.fn(async () => false)
    const revoke = vi.fn()
    monitorAccess(check, revoke)()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(check).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })
})
