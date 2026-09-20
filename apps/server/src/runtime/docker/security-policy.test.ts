import { describe, expect, it } from 'vitest'
import { instanceSecurityPolicy } from './security-policy.js'

describe('instance security policy', () => {
  it('bounds writable surfaces and removes privilege escalation paths', () => {
    const policy = instanceSecurityPolicy(2048)
    expect(policy.ReadonlyRootfs).toBe(true)
    expect(policy.CapDrop).toEqual(['ALL'])
    expect(policy.SecurityOpt).toEqual(['no-new-privileges'])
    expect(policy.MemorySwap).toBe(2048 * 1024 * 1024)
    expect(policy.Tmpfs?.['/tmp']).toContain('size=256m')
    expect(policy.LogConfig).toEqual({
      Type: 'local', Config: { 'max-size': '10m', 'max-file': '3' },
    })
    expect(policy.Privileged).not.toBe(true)
    expect(policy.NetworkMode).toBeUndefined()
  })

  it('scales scratch space down for small instances', () => {
    expect(instanceSecurityPolicy(128).Tmpfs?.['/tmp']).toContain('size=32m')
    expect(instanceSecurityPolicy(128).ShmSize).toBe(32 * 1024 * 1024)
  })
})
