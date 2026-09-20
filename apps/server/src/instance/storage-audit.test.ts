import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditStorage } from './storage-audit.js'

describe('read-only storage audit', () => {
  it('reports incomplete and orphaned storage without changing data or the registry', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-audit-')))
    try {
      const active = 'a'.repeat(32)
      const missing = 'b'.repeat(32)
      const released = 'c'.repeat(32)
      const unsafe = 'd'.repeat(32)
      const recovery = `${active}.recovery`
      const records = Object.fromEntries([active, missing, released, unsafe, recovery].map((key, i) =>
        [key, { projid: i + 2, sizeMb: 1024, inodeLimit: 1000,
          ...(key === active ? { pending: true } : {}), ...(key === released ? { released: true } : {}) }]))
      const text = JSON.stringify(records)
      await writeFile(join(root, '.dsh-projects.json'), text)
      for (const name of [active, released, recovery, 'orphan']) await mkdir(join(root, name))
      await symlink('/does-not-exist', join(root, unsafe))
      await writeFile(join(root, active, 'sentinel'), 'private content')
      const report = await auditStorage(root)
      expect(report.consistentSnapshot).toBe(false)
      expect(report.findings).toEqual(expect.arrayContaining([
        { key: active, issue: 'pending' }, { key: missing, issue: 'missing' },
        { key: released, issue: 'released-present' }, { key: unsafe, issue: 'unsafe-entry' },
        { key: recovery, issue: 'recovery-present' }, { key: 'orphan', issue: 'unregistered' },
      ]))
      expect(report.findings).toHaveLength(6)
      expect(JSON.stringify(report)).not.toContain('private content')
      expect(await readFile(join(root, '.dsh-projects.json'), 'utf8')).toBe(text)
      expect(await readFile(join(root, active, 'sentinel'), 'utf8')).toBe('private content')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not initialize a missing registry or follow a registry symlink', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-audit-missing-')))
    try {
      await expect(auditStorage(root)).rejects.toThrow()
      expect(await readdir(root)).toEqual([])
      await writeFile(join(root, 'external'), '{}')
      await symlink(join(root, 'external'), join(root, '.dsh-projects.json'))
      await expect(auditStorage(root)).rejects.toThrow('regular file')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
