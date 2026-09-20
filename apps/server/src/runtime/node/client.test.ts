import { createServer, type RequestListener } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeRuntimeDriver } from './client.js'

async function withServer(handler: RequestListener, run: (client: NodeRuntimeDriver) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-client-'))
  const server = createServer(handler)
  const path = join(directory, 'n.sock')
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    await run(new NodeRuntimeDriver(path, { health: 50, read: 50, mutation: 50 }))
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

describe('node client failure handling', () => {
  it.each(['{}', 'null', '[]', '{"error":"failed"}', '{"value":null,"error":"failed"}'])('rejects malformed success %s', async body => {
    await withServer((_req, res) => { res.end(body) }, async client => {
      await expect(client.stop('dsh-instance-alice')).rejects.toThrow('Invalid node')
    })
  })

  it('does not retry an operation after a timeout', async () => {
    let calls = 0
    await withServer(() => { calls++ }, async client => {
      await expect(client.remove('dsh-instance-alice')).rejects.toThrow()
      expect(calls).toBe(1)
    })
  })

  it('rejects a response interrupted after headers instead of treating it as success', async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { 'content-length': '100' })
      res.write('{"value":')
      setImmediate(() => res.destroy())
    }, async client => {
      await expect(client.stop('dsh-instance-alice')).rejects.toThrow()
    })
  })

  it('bounds a stalled health response', async () => {
    await withServer(() => {}, async client => { await expect(client.ready()).rejects.toThrow() })
  })
})
