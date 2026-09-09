/** One update flow per extension instance, including its notification and installation. */
export class UpdateRun {
  private pending: Promise<void> | undefined
  private disposed = false

  run(work: (current: () => boolean) => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.pending) return this.pending
    const pending = Promise.resolve()
      .then(() => {
        if (this.disposed) return
        return work(() => !this.disposed)
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined
      })
    this.pending = pending
    return pending
  }

  dispose() {
    this.disposed = true
  }
}
