import { describe, expect, it } from 'vitest'
import { DomainSchema } from './domain.js'

describe('deployment domain syntax', () => {
  it.each(['example.com', 'console.example.net', 'lvh.me', 'xn--bcher-kva.example'])('accepts %s', value => {
    expect(DomainSchema.safeParse(value).success).toBe(true)
  })
  it.each(['example..com', '.example.com', 'example.com.', '-bad.example', 'bad-.example',
    '127.0.0.1', 'localhost', 'Example.com', 'example.com:443', 'example.com/path',
    `${'a'.repeat(64)}.example`, 'a_b.example'])('rejects %s', value => {
    expect(DomainSchema.safeParse(value).success).toBe(false)
  })
})
