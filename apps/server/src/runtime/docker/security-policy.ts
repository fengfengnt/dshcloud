import type Docker from 'dockerode'

export const RUNTIME_POLICY_VERSION = '2026-09-19.1'

/** Keep writable scratch space bounded without preventing compiler output execution. */
export function instanceSecurityPolicy(memoryMb: number): Docker.HostConfig {
  const scratchMb = Math.max(1, Math.min(256, Math.floor(memoryMb / 4)))
  return {
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    MemorySwap: memoryMb * 1024 * 1024,
    Tmpfs: {
      '/tmp': `rw,nosuid,nodev,size=${scratchMb}m,mode=1777`,
      '/run': 'rw,nosuid,nodev,noexec,size=16m,mode=755',
    },
    ShmSize: Math.min(64, scratchMb) * 1024 * 1024,
    Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
    LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '3' } },
  }
}
