import { describe, expect, it } from 'vitest'
import { assertProductionConfig } from './production-config.js'

describe('production browser security prerequisites', () => {
  it.each(['http://localhost:5173', 'https://alice.example.com', 'https://*.example.com'])(
    'rejects extra production trust for %s', origin => {
      expect(() => assertProductionConfig({ PUBLIC_SCHEME: 'https', EXTRA_TRUSTED_ORIGINS: origin }, true))
        .toThrow('EXTRA_TRUSTED_ORIGINS')
      expect(() => assertProductionConfig({ PUBLIC_SCHEME: 'https', EXTRA_TRUSTED_ORIGINS: origin }, false))
        .not.toThrow()
    },
  )
  it('rejects plaintext production configuration before startup', () => {
    expect(() => assertProductionConfig({ PUBLIC_SCHEME: 'http' }, true)).toThrow('PUBLIC_SCHEME=https')
  })
  it('allows TLS production and plaintext local development', () => {
    expect(() => assertProductionConfig({ PUBLIC_SCHEME: 'https' }, true)).not.toThrow()
    expect(() => assertProductionConfig({ PUBLIC_SCHEME: 'http' }, false)).not.toThrow()
  })
})
