import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Docker from 'dockerode'
import { describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ removePath: '', copy: new Error('copy failed'), clear: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: (_command: string, _args: string[], callback: (error: Error) => void) => callback(faults.copy),
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: async (path: string, options: Parameters<typeof actual.rm>[1]) => {
    if (path === faults.removePath) throw new Error('directory removal failed')
    return actual.rm(path, options)
  } }
})
vi.mock('../../instance/pool.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../instance/pool.js')>(),
  setProjectQuota: vi.fn(async () => {}),
  clearProject: faults.clear,
}))

import { DockerDriver } from './driver.js'
import { ProjectRegistry } from '../../instance/pool.js'

describe('failed storage copy cleanup', () => {
  it.each([true, false])('preserves quota until data removal succeeds (removal failure: %s)', async failRemoval => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-copy-cleanup-'))
    const key = 'a'.repeat(32)
    const target = `${key}.recovery`
    faults.clear.mockClear()
    try {
      const registry = new ProjectRegistry(root)
      await registry.allocate(key, 1024, 1000)
      await mkdir(join(root, key))
      await writeFile(join(root, key, 'sentinel'), 'current data')
      faults.removePath = failRemoval ? join(root, target) : ''
      const driver = new DockerDriver({
        docker: { listContainers: async () => [] } as unknown as Docker,
        pool: { root, enforced: true, detail: 'test' },
      })
      if (failRemoval) {
        const error = await driver.copyStorage(key, target).catch(error => error)
        expect(error).toBeInstanceOf(AggregateError)
        expect(error.errors[0]).toBe(faults.copy)
        expect(error.errors[1].message).toBe('directory removal failed')
        expect(faults.clear).not.toHaveBeenCalled()
        expect((await new ProjectRegistry(root).get(target))?.pending).toBe(true)
        await expect(driver.ensureStorage(target)).rejects.toThrow('incomplete')
      } else {
        await expect(driver.copyStorage(key, target)).rejects.toBe(faults.copy)
        expect(faults.clear).toHaveBeenCalledOnce()
        expect(await registry.get(target)).toBeUndefined()
      }
      expect(await readFile(join(root, key, 'sentinel'), 'utf8')).toBe('current data')
    } finally {
      faults.removePath = ''
      await rm(root, { recursive: true, force: true })
    }
  })
})
