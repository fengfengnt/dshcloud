import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createConnection } from 'node:net'
import { z } from 'zod'
import { createLocalRuntime } from '../local.js'
import { createNodeService } from './server.js'

const config = z.object({
  DSH_NODE_SOCKET: z.string().startsWith('/').default('/run/dsh-node/agent.sock'),
  HOST_STORAGE_ROOT: z.string().startsWith('/').default('/var/lib/dsh'),
  HOST_POOL_SIZE_MB: z.coerce.number().int().positive().optional(),
  INSTANCE_IMAGE_REPO: z.string().min(1).default('ghcr.io/eskim2001/dsh-instance'),
  SELF_CONTAINER: z.string().min(1),
}).parse(process.env)

const driver = await createLocalRuntime({ root: config.HOST_STORAGE_ROOT,
  ...(config.HOST_POOL_SIZE_MB === undefined ? {} : { sizeMb: config.HOST_POOL_SIZE_MB }),
  containerized: true, production: true, selfContainer: config.SELF_CONTAINER })

// The control plane mounts this directory read-only. Only the node owns its socket lifecycle.
const directory = dirname(config.DSH_NODE_SOCKET)
await mkdir(directory, { recursive: true, mode: 0o700 })
const dirInfo = await lstat(directory)
if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || dirInfo.uid !== process.getuid?.()) {
  throw new Error('Node socket directory is not owned by this process')
}
await chmod(directory, 0o700)
const existing = await lstat(config.DSH_NODE_SOCKET).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return undefined
})
if (existing) {
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('Unsafe node socket path')
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(config.DSH_NODE_SOCKET)
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); reject(new Error('Node service is already running')) })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Existing node socket did not respond')) })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve()
      else reject(error)
    })
  })
  await unlink(config.DSH_NODE_SOCKET).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}
process.umask(0o077)
const app = createNodeService(driver, config.INSTANCE_IMAGE_REPO)
await app.listen({ path: config.DSH_NODE_SOCKET })
await chmod(config.DSH_NODE_SOCKET, 0o600)
console.log('Node service ready on Unix socket')
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)))
}
