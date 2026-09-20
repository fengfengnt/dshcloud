/** Keep the slot until the underlying work settles, even after an HTTP deadline. */
export function authorizationCapacity(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid authorization capacity')
  let active = 0
  return async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (active >= limit) throw new Error('Authorization capacity exhausted')
    active++
    try {
      return await operation()
    } finally {
      active--
    }
  }
}
