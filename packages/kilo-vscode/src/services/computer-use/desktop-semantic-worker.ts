import type { Runner } from "./desktop-windows"

/** A fresh accessibility read has its own process lifetime, independent of pixels and input. */
export class DesktopSemanticWorker {
  private generation = 0
  private active: { reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined

  constructor(
    private readonly source: Runner,
    private readonly timeout = 15_000,
  ) {
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 15_000)
      throw new Error("Desktop semantic deadline is invalid")
  }

  read(script: string): Promise<string> {
    if (this.active) return Promise.reject(new Error("A desktop semantic read is already active"))
    const generation = this.generation
    const started = performance.now()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new Error("Desktop semantic read timed out")), this.timeout)
      const pending = { reject, timer }
      this.active = pending
      Promise.resolve()
        .then(() => {
          if (this.active !== pending || generation !== this.generation)
            throw new Error("Desktop semantic read was cancelled")
          if (performance.now() - started >= this.timeout) throw new Error("Desktop semantic read timed out")
          return this.source.run(script)
        })
        .then(
          (value) => {
            if (this.active !== pending || generation !== this.generation) return
            if (performance.now() - started >= this.timeout) {
              this.stop(new Error("Desktop semantic read timed out"))
              return
            }
            clearTimeout(timer)
            this.active = undefined
            resolve(value)
          },
          (error: unknown) => {
            if (this.active !== pending || generation !== this.generation) return
            this.stop(error instanceof Error ? error : new Error("Desktop semantic read failed", { cause: error }))
          },
        )
    })
  }

  cancel(): void {
    this.stop(new Error("Desktop semantic read was cancelled"))
  }

  private stop(error: Error): void {
    this.generation += 1
    const pending = this.active
    this.active = undefined
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.source.cancel()
  }
}
