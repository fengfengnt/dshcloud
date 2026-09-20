import { createDocker } from '../docker/client.js'
import { ensureStoragePool, ProjectRegistry } from '../instance/pool.js'
import { DockerDriver } from './docker/driver.js'
import { assertProductionHost } from './docker/host-admission.js'
import { probeProductionRuntime } from './docker/admission-probe.js'
import { detectLxcfsProc } from './docker/lxcfs.js'
import { assertStorageRoot } from './docker/storage-root.js'

export async function createLocalRuntime(options: {
  root: string; sizeMb?: number; containerized: boolean; production: boolean; selfContainer: string
}): Promise<DockerDriver> {
  if (options.production) {
    await assertStorageRoot(options.root)
    const docker = createDocker()
    assertProductionHost(await docker.info())
    await probeProductionRuntime(docker, options.selfContainer)
  }
  const pool = await ensureStoragePool({ root: options.root, containerized: options.containerized,
    ...(options.sizeMb === undefined ? {} : { sizeMb: options.sizeMb }) })
  if (options.production && !pool.enforced) throw new Error('Production requires enforced storage quotas')
  if (pool.enforced) await new ProjectRegistry(pool.root).keys()
  if (!pool.enforced) console.warn(`Storage quotas are not enforced: ${pool.detail}`)
  const lxcfsProcDir = await detectLxcfsProc()
  return new DockerDriver({ pool, ...(lxcfsProcDir === null ? {} : { lxcfsProcDir }) })
}
