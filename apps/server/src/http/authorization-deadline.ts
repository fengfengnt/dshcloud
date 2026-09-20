export async function authorizationDeadline<T>(operation: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Authorization deadline exceeded')), milliseconds)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
