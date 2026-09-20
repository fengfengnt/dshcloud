/** A stalled authorization service must not keep an established stream alive. */
export function monitorAccess(check: () => Promise<boolean>, revoke: () => void): () => void {
  let stopped = false
  let deadline: ReturnType<typeof setTimeout> | undefined
  let next: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    stopped = true
    if (deadline) clearTimeout(deadline)
    if (next) clearTimeout(next)
  }
  const deny = () => {
    if (stopped) return
    stop()
    revoke()
  }
  const schedule = () => {
    next = setTimeout(() => {
      deadline = setTimeout(deny, 5_000)
      deadline.unref()
      void Promise.resolve().then(check).then(allowed => {
        if (stopped) return
        if (deadline) clearTimeout(deadline)
        if (!allowed) deny()
        else schedule()
      }).catch(deny)
    }, 25_000)
    next.unref()
  }
  schedule()
  return stop
}
