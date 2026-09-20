/** Serialize complete lifecycle workflows, not individual runtime RPCs. */
export class OperationQueue {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0

  constructor(private readonly capacity = 16) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= this.capacity) {
      throw Object.assign(new Error('工作空间操作繁忙，请稍后重试'), { statusCode: 503 })
    }
    this.pending++
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await operation() } finally {
      this.pending--
      release()
    }
  }
}

export const lifecycleOperations = new OperationQueue()
