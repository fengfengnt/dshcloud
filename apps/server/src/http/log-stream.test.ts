import { PassThrough } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { streamContainerLogs } from './log-stream.js'

describe('log stream disconnect handling', () => {
  it.each(['total', 'backlog', 'source-error'])('closes an abusive or failed log source: %s', async mode => {
    const source = new PassThrough()
    const response = Object.assign(new PassThrough(), { writeHead: vi.fn() })
    if (mode !== 'backlog') response.resume()
    await streamContainerLogs(
      { raw: { aborted: false } } as FastifyRequest,
      { raw: response, hijack: vi.fn() } as unknown as FastifyReply,
      'instance', { tail: 10 }, async () => source,
      (raw, out) => { raw.pipe(out) },
    )
    if (mode === 'source-error') source.emit('error', new Error('source failed'))
    else if (mode === 'total') source.write(Buffer.alloc(4 * 1024 * 1024 + 1, 65))
    else {
      for (let i = 0; i < 100 && !source.destroyed; i++) source.write(`${'x'.repeat(32_000)}\n`)
    }
    expect(source.destroyed).toBe(true)
    expect(response.destroyed || response.writableEnded).toBe(true)
  })
  it('destroys late logs instead of sending them after client disconnect', async () => {
    const source = new PassThrough()
    const response = new PassThrough()
    const hijack = vi.fn()
    const demux = vi.fn()
    await streamContainerLogs(
      { raw: { aborted: false } } as FastifyRequest,
      { raw: response, hijack } as unknown as FastifyReply,
      'instance', { tail: 10 },
      async () => { response.destroy(); return source }, demux,
    )
    expect(source.destroyed).toBe(true)
    expect(hijack).not.toHaveBeenCalled()
    expect(demux).not.toHaveBeenCalled()
  })

  it('does not attempt an error response after the client has disconnected', async () => {
    const response = new PassThrough()
    const code = vi.fn()
    await streamContainerLogs(
      { raw: { aborted: false } } as FastifyRequest,
      { raw: response, code } as unknown as FastifyReply,
      'instance', { tail: 10 },
      async () => { response.destroy(); throw new Error('unavailable') }, vi.fn(),
    )
    expect(code).not.toHaveBeenCalled()
  })
})
