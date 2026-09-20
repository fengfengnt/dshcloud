import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readBoundedLogs } from './log-reader.js'
import type Docker from 'dockerode'
import { DockerDriver } from './driver.js'

describe('bounded Docker logs', () => {
  it.each([false, true])('enforces the bounded reader through the driver (oversized: %s)', async oversized => {
    const payload = Buffer.from('用户日志\n')
    const header = Buffer.alloc(8)
    header[0] = 1
    header.writeUInt32BE(payload.length, 4)
    const stream = oversized ? Readable.from([Buffer.alloc(1024 * 1024 + 1)])
      : Readable.from([header.subarray(0, 3), header.subarray(3), payload])
    let options: Docker.ContainerLogsOptions | undefined
    const docker = { getContainer: () => ({
      inspect: async () => ({ Id: 'checked-id', Name: '/dsh-instance-alice',
        Config: { Labels: { 'dsh.cloud/managed': 'true', 'dsh.cloud/instance': 'alice' } } }),
      logs: async (args: Docker.ContainerLogsOptions) => { options = args; return stream },
    }) } as unknown as Docker
    const driver = new DockerDriver({ docker })
    if (oversized) await expect(driver.logs('dsh-instance-alice', 10)).rejects.toThrow('exceed')
    else expect(await driver.logs('dsh-instance-alice', 10)).toBe('用户日志\n')
    expect(options?.follow).toBe(true)
    expect(options?.tail).toBe(10)
    expect(Number.isFinite(Date.parse(String(options?.until)))).toBe(true)
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal)
    expect(stream.destroyed).toBe(true)
  })
  it('preserves binary frames across chunks', async () => {
    const stream = Readable.from([Buffer.from([0, 1]), Buffer.from([2, 255])])
    expect(await readBoundedLogs(stream, new AbortController().signal, 4)).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(stream.destroyed).toBe(true)
  })
  it('rejects oversized output and closes the source', async () => {
    const stream = Readable.from([Buffer.alloc(5)])
    await expect(readBoundedLogs(stream, new AbortController().signal, 4)).rejects.toThrow('exceed')
    expect(stream.destroyed).toBe(true)
  })
  it('cancels a stalled source', async () => {
    const stream = new PassThrough()
    const controller = new AbortController()
    const reading = readBoundedLogs(stream, controller.signal)
    const check = expect(reading).rejects.toThrow('timed out')
    controller.abort()
    await check
    expect(stream.destroyed).toBe(true)
  })
})
