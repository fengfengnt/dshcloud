import { parse, serialize } from 'cookie'

/** Only retire the old parent-domain namespace, never the new host-only cookies. */
export function expireLegacyCookies(header: string | undefined, domain: string, secure: boolean): string[] {
  if (!domain) return []
  return Object.keys(parse(header ?? ''))
    .filter(name => /^(?:__Secure-)?dsh_cloud\.(?:session_token|session_data|account_data|dont_remember)(?:\.\d+)?$/.test(name))
    .map(name => serialize(name, '', {
      domain, path: '/', httpOnly: true, secure: secure || name.startsWith('__Secure-'),
      sameSite: 'lax', expires: new Date(0), maxAge: 0,
    }))
}
