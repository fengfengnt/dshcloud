export function safeLoginRedirect(value: string, origin: string): string {
  if (/[\\\u0000-\u0020\u007f]/.test(value)) return '/'
  try {
    const base = new URL(origin)
    const target = new URL(value, base)
    if (target.origin !== base.origin || target.username || target.password) return '/'
    return target.toString()
  } catch {
    return '/'
  }
}
