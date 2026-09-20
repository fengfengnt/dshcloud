export interface HostCapabilities {
  OSType?: string
  OperatingSystem?: string
  SecurityOptions?: string[]
  MemoryLimit?: boolean
  SwapLimit?: boolean
  PidsLimit?: boolean
  CpuCfsQuota?: boolean
}

/** Daemon declarations are necessary, but do not replace an execution probe. */
export function hostAdmissionFailures(info: HostCapabilities): string[] {
  const failures: string[] = []
  if (info.OSType !== 'linux') failures.push('Linux container engine required')
  if (/docker desktop/i.test(info.OperatingSystem ?? '')) {
    failures.push('Docker Desktop is not a supported production host')
  }
  if (!info.SecurityOptions?.some((option) => option.split(',').includes('name=seccomp'))) {
    failures.push('Docker does not report seccomp support')
  }
  for (const key of ['MemoryLimit', 'SwapLimit', 'PidsLimit', 'CpuCfsQuota'] as const) {
    if (info[key] !== true) failures.push(`Docker does not report ${key} support`)
  }
  return failures
}

export function assertProductionHost(info: HostCapabilities): void {
  const failures = hostAdmissionFailures(info)
  if (failures.length > 0) {
    throw new Error(`Production host admission rejected: ${failures.join('; ')}`)
  }
}
