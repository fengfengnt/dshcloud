import { auditStorage } from '../src/instance/storage-audit.js'

try {
  if (process.argv.length > 2) throw new Error('storage-audit takes no arguments; use HOST_STORAGE_ROOT')
  const root = process.env.HOST_STORAGE_ROOT ?? '/var/lib/dsh'
  const report = await auditStorage(root)
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.findings.length === 0 ? 0 : 2
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}
