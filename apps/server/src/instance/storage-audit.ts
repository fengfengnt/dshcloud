import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, normalize, parse, join } from 'node:path'
import { ProjectRegistry } from './pool.js'

export interface StorageAuditFinding {
  key: string
  issue: 'pending' | 'missing' | 'unsafe-entry' | 'released-present' | 'unregistered' | 'recovery-present'
}

/** Metadata-only observation; another process can change the pool during inspection. */
export async function auditStorage(root: string): Promise<{
  consistentSnapshot: false
  records: number
  findings: StorageAuditFinding[]
}> {
  if (!isAbsolute(root) || normalize(root) !== root || root === parse(root).root || await realpath(root) !== root) {
    throw new Error('Audit requires a canonical pool path without symbolic links')
  }
  const registryPath = join(root, '.dsh-projects.json')
  const info = await lstat(registryPath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Registry must be a regular file')
  const records = await new ProjectRegistry(root).inspect()
  const entries = new Map((await readdir(root, { withFileTypes: true })).map(entry => [entry.name, entry]))
  const findings: StorageAuditFinding[] = []
  for (const [key, record] of records) {
    const entry = entries.get(key)
    if (record.pending && !record.released) findings.push({ key, issue: 'pending' })
    if (!entry && !record.released) findings.push({ key, issue: 'missing' })
    if (entry) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) findings.push({ key, issue: 'unsafe-entry' })
      if (record.released) findings.push({ key, issue: 'released-present' })
      if (key.endsWith('.recovery')) findings.push({ key, issue: 'recovery-present' })
    }
  }
  for (const [key, entry] of entries) {
    if (records.has(key)) continue
    if (key === '.dsh-projects.json') continue
    if (key === '.dsh-node.lock' && entry.isFile()) continue
    if (key === 'lost+found' && entry.isDirectory()) continue
    findings.push({ key, issue: 'unregistered' })
  }
  findings.sort((a, b) => a.key.localeCompare(b.key) || a.issue.localeCompare(b.issue))
  return { consistentSnapshot: false, records: records.size, findings }
}
