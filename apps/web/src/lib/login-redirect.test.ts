import { describe, expect, it } from 'vitest'
import { safeLoginRedirect } from './login-redirect.js'

describe('login return destination', () => {
  const origin = 'https://console.example.com'
  it.each(['//evil.test', '/\\evil.test', '/\t/evil.test', 'javascript:alert(1)', 'https://alice.console.example.com', 'http://console.example.com', 'https://user:pass@console.example.com'])('rejects %j', value => {
    expect(safeLoginRedirect(value, origin)).toBe('/')
  })
  it('preserves same-origin server authorization navigation and query', () => {
    expect(safeLoginRedirect('/api/workspace/authorize?slug=alice&state=abc', origin))
      .toBe(`${origin}/api/workspace/authorize?slug=alice&state=abc`)
  })
})
