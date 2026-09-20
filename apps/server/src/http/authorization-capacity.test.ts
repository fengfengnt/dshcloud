import { describe, expect, it } from 'vitest'
import { authorizationCapacity } from './authorization-capacity.js'

describe('authorization capacity', () => {
  it('rejects new work while the actual operation is pending', async () => {
    const run = authorizationCapacity(1)
    let finish!: () => void
    const active = run(() => new Promise<void>(resolve => { finish = resolve }))
    let started = false
    await expect(run(async () => { started = true })).rejects.toThrow('capacity')
    expect(started).toBe(false)
    finish()
    await active
    expect(await run(async () => 'allowed')).toBe('allowed')
  })
  it('releases slots after synchronous and asynchronous failures', async () => {
    const run = authorizationCapacity(1)
    await expect(run(() => { throw new Error('sync') })).rejects.toThrow('sync')
    await expect(run(async () => { throw new Error('async') })).rejects.toThrow('async')
    expect(await run(async () => true)).toBe(true)
  })
})
