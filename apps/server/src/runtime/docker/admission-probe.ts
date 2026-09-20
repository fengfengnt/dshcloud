import { randomUUID } from 'node:crypto'
import type Docker from 'dockerode'
import { instanceSecurityPolicy } from './security-policy.js'

// Inspect the trusted probe process, never a process supplied by a workspace.
export const ADMISSION_PROBE = `
const fs = require('node:fs');
const status = fs.readFileSync('/proc/self/status', 'utf8');
const fields = Object.fromEntries(status.trim().split('\\n').map(line => {
  const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1).trim()];
}));
if (process.getuid() !== 1000 || fields.NoNewPrivs !== '1' ||
    fields.Seccomp !== '2' || !/^0+$/.test(fields.CapEff || '')) process.exit(10);
const rootMounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\\n')
  .map(line => line.split(' ')).filter(parts => parts[4] === '/');
if (rootMounts.length !== 1 || !rootMounts[0][5].split(',').includes('ro')) process.exit(12);
try { fs.writeFileSync('/.dsh-admission-test', 'x'); process.exit(11); }
catch (error) { if (error.code !== 'EROFS' && error.code !== 'EACCES') throw error; }
fs.writeFileSync('/tmp/dsh-admission-test', 'x');
`

export async function probeProductionRuntime(docker: Docker, selfContainer: string): Promise<void> {
  if (!selfContainer) throw new Error('SELF_CONTAINER is required for production runtime admission')
  const self = await docker.getContainer(selfContainer).inspect()
  // An immutable local image ID avoids both tag drift and network pulls at startup.
  if (!/^sha256:[a-f0-9]{64}$/.test(self.Image)) throw new Error('Invalid platform image ID')
  const container = await docker.createContainer({
    name: `dsh-admission-${randomUUID()}`,
    Image: self.Image,
    Entrypoint: ['/usr/local/bin/node'],
    Cmd: ['-e', ADMISSION_PROBE],
    User: '1000:1000',
    WorkingDir: '/tmp',
    Labels: { 'dsh.cloud/admission-probe': 'true' },
    HostConfig: {
      ...instanceSecurityPolicy(128),
      NetworkMode: 'none',
      Memory: 128 * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 32,
      RestartPolicy: { Name: 'no' },
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        await container.start()
        const result = await container.wait()
        if (result.StatusCode !== 0 || result.Error) {
          throw new Error(`Production runtime probe rejected (exit ${result.StatusCode})`)
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Production runtime probe timed out')), 15_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    await container.remove({ force: true, v: true })
  }
}
