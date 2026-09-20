import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ code: 'EADDRINUSE', listen: vi.fn() }))
vi.mock('node:net', () => ({
  createServer: () => {
    const server = new EventEmitter()
    return Object.assign(server, {
      unref: () => server,
      listen: () => {
        mock.listen()
        queueMicrotask(() => server.emit('error', Object.assign(new Error('bind failed'), { code: mock.code })))
      },
    })
  },
}))
import { allocateHostPort, isPortFree } from './port-allocator.js'

describe('host port probe failures', () => {
  it('only treats address-in-use as an occupied port', async () => {
    mock.code = 'EADDRINUSE'
    expect(await isPortFree(20000)).toBe(false)
  })
  it.each(['EACCES', 'EPERM', 'EMFILE'])('stops allocation immediately on %s', async code => {
    mock.code = code
    mock.listen.mockClear()
    await expect(allocateHostPort({ takenPorts: async () => new Set() })).rejects.toThrow(code)
    expect(mock.listen).toHaveBeenCalledOnce()
  })
})
