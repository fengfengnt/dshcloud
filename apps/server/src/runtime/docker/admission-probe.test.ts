import type Docker from 'dockerode'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { ADMISSION_PROBE, probeProductionRuntime } from './admission-probe.js'

function fixture(code = 0) {
  const remove = vi.fn(async () => undefined)
  const start = vi.fn(async () => undefined)
  const createContainer = vi.fn(async (_config: unknown) => ({
    start, wait: async () => ({ StatusCode: code }), remove,
  }))
  const docker = {
    getContainer: () => ({ inspect: async () => ({ Image: `sha256:${'a'.repeat(64)}` }) }),
    createContainer,
  } as unknown as Docker
  return { docker, createContainer, remove, start }
}

describe('runtime admission probe', () => {
  it.each(['rw', 'ro'])('checks actual root mount flags (%s), not only a failed write', flags => {
    const writeFileSync = vi.fn((path: string) => {
      if (path === '/.dsh-admission-test') throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })
    const run = () => runInNewContext(ADMISSION_PROBE, {
      require: () => ({
        readFileSync: (path: string) => path === '/proc/self/status'
          ? 'NoNewPrivs: 1\nSeccomp: 2\nCapEff: 00000000\n'
          : `1 0 0:1 / / ${flags},relatime - overlay overlay rw\n`,
        writeFileSync,
      }),
      process: { getuid: () => 1000, exit: (code: number) => { throw new Error(`exit ${code}`) } },
    })
    if (flags === 'rw') {
      expect(run).toThrow('exit 12')
      expect(writeFileSync).not.toHaveBeenCalled()
    } else {
      expect(run).not.toThrow()
      expect(writeFileSync).toHaveBeenCalledWith('/tmp/dsh-admission-test', 'x')
    }
  })
  it('uses an isolated trusted image and cleans up after success', async () => {
    const f = fixture()
    await probeProductionRuntime(f.docker, 'platform')
    expect(f.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      Image: `sha256:${'a'.repeat(64)}`, User: '1000:1000',
      HostConfig: expect.objectContaining({ NetworkMode: 'none', ReadonlyRootfs: true }),
    }))
    expect(f.remove).toHaveBeenCalledWith({ force: true, v: true })
  })
  it('rejects failed enforcement and still removes the probe', async () => {
    const f = fixture(10)
    await expect(probeProductionRuntime(f.docker, 'platform')).rejects.toThrow('exit 10')
    expect(f.remove).toHaveBeenCalledOnce()
  })
  it('cleans up after a startup failure', async () => {
    const f = fixture()
    f.start.mockRejectedValue(new Error('start failed'))
    await expect(probeProductionRuntime(f.docker, 'platform')).rejects.toThrow('start failed')
    expect(f.remove).toHaveBeenCalledOnce()
  })
  it('does not create a probe without a trusted platform identity', async () => {
    const f = fixture()
    await expect(probeProductionRuntime(f.docker, '')).rejects.toThrow('SELF_CONTAINER')
    expect(f.createContainer).not.toHaveBeenCalled()
  })
  it('times out a stalled process and removes it', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.start.mockImplementation(() => new Promise(() => {}))
      const result = expect(probeProductionRuntime(f.docker, 'platform'))
        .rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(15_000)
      await result
      expect(f.remove).toHaveBeenCalledWith({ force: true, v: true })
    } finally {
      vi.useRealTimers()
    }
  })
})
