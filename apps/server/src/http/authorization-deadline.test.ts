import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizationDeadline } from './authorization-deadline.js'

afterEach(() => vi.useRealTimers())
describe('authorization deadline', () => {
  it('fails closed when the identity service never resolves', async () => {
    vi.useFakeTimers()
    const assertion = expect(authorizationDeadline(new Promise(() => {}))).rejects.toThrow('deadline')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cleans up the timer after success or failure', async () => {
    vi.useFakeTimers()
    expect(await authorizationDeadline(Promise.resolve('alice'))).toBe('alice')
    await expect(authorizationDeadline(Promise.reject(new Error('offline')))).rejects.toThrow('offline')
    expect(vi.getTimerCount()).toBe(0)
  })
})
