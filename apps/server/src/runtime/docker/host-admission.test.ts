import { describe, expect, it } from 'vitest'
import { assertProductionHost, hostAdmissionFailures } from './host-admission.js'

const supported = {
  OSType: 'linux', OperatingSystem: 'Debian GNU/Linux',
  SecurityOptions: ['name=seccomp,profile=builtin', 'name=apparmor'],
  MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsQuota: true,
}

describe('production host admission', () => {
  it('accepts required daemon capabilities', () => {
    expect(() => assertProductionHost(supported)).not.toThrow()
  })
  it('fails closed on missing capability information', () => {
    expect(hostAdmissionFailures({})).toHaveLength(6)
    expect(() => assertProductionHost({})).toThrow('admission rejected')
  })
  it.each(['MemoryLimit', 'SwapLimit', 'PidsLimit', 'CpuCfsQuota'] as const)(
    'rejects missing %s enforcement', (key) => {
      expect(hostAdmissionFailures({ ...supported, [key]: false })).toEqual([
        `Docker does not report ${key} support`,
      ])
    },
  )
  it('does not mistake an unrelated option for seccomp support', () => {
    expect(hostAdmissionFailures({ ...supported, SecurityOptions: ['name=not-seccomp'] }))
      .toEqual(['Docker does not report seccomp support'])
  })
  it('rejects Docker Desktop even though its engine runs Linux', () => {
    expect(() => assertProductionHost({ ...supported, OperatingSystem: 'Docker Desktop' }))
      .toThrow('not a supported production host')
  })
})
