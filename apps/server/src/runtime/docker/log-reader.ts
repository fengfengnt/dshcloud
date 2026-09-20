import type { Readable } from 'node:stream'

export async function readBoundedLogs(stream: Readable, signal: AbortSignal, limit = 1024 * 1024): Promise<Buffer> {
  const abort = () => stream.destroy(new Error('Container log read timed out'))
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Buffer[] = []
  let size = 0
  try {
    signal.throwIfAborted()
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      size += chunk.length
      if (size > limit) throw new Error('Container logs exceed read limit; request fewer lines')
      chunks.push(chunk)
    }
    signal.throwIfAborted()
    return Buffer.concat(chunks, size)
  } finally {
    signal.removeEventListener('abort', abort)
    stream.destroy()
  }
}
