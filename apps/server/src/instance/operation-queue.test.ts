import { describe, expect, it } from 'vitest'
import { OperationQueue } from './operation-queue.js'

describe('lifecycle operation queue', () => {
  it('prevents a start from interleaving with a stopped-volume snapshot', async () => {
    const queue = new OperationQueue()
    const events: string[] = []
    let finishSnapshot!: () => void
    const snapshot = new Promise<void>(resolve => { finishSnapshot = resolve })
    const upgrade = queue.run(async () => {
      events.push('stop')
      await snapshot
      events.push('snapshot-complete', 'rebuild')
    })
    const start = queue.run(async () => { events.push('start') })
    await Promise.resolve()
    expect(events).toEqual(['stop'])
    finishSnapshot()
    await Promise.all([upgrade, start])
    expect(events).toEqual(['stop', 'snapshot-complete', 'rebuild', 'start'])
  })

  it('bounds pending operations and releases capacity on failure', async () => {
    const queue = new OperationQueue(1)
    let fail!: (error: Error) => void
    const active = queue.run(() => new Promise<void>((_, reject) => { fail = reject }))
    await Promise.resolve()
    await expect(queue.run(async () => 'unexpected')).rejects.toMatchObject({ statusCode: 503 })
    const rejected = expect(active).rejects.toThrow('snapshot failed')
    fail(new Error('snapshot failed'))
    await rejected
    expect(await queue.run(async () => 'recovered')).toBe('recovered')
  })
})
