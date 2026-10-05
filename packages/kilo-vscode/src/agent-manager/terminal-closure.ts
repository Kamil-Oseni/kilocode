import type { NativeTask } from "./run/task-native"

/** A close notification supplies no native authority. Both observations must settle. */
export class TerminalClosure {
  private readonly native: Promise<NativeTask>
  private readonly event: Promise<void>
  private resolve: () => void = () => undefined
  private retirement: Promise<void> | undefined
  private failure: unknown

  constructor(pid: PromiseLike<number | undefined>, bind: (pid: number) => Promise<NativeTask>) {
    this.event = new Promise<void>((resolve) => {
      this.resolve = resolve
    })
    this.native = Promise.resolve(pid).then((pid) => {
      if (!Number.isSafeInteger(pid) || !pid || pid <= 0) throw new Error("Terminal process identity is unknown")
      return bind(pid)
    })
    void this.native.catch((err: unknown) => {
      this.failure = err
    })
  }

  closed(): void {
    this.resolve()
  }

  close(terminate: () => void): Promise<void> {
    return (this.retirement ??= (async () => {
      const owner = await this.native
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 10000)
      const event = new Promise<void>((resolve, reject) => {
        const expired = () => reject(new Error("Terminal close event was not confirmed"))
        abort.signal.addEventListener("abort", expired, { once: true })
        void this.event.then(() => {
          abort.signal.removeEventListener("abort", expired)
          resolve()
        })
      })
      try {
        const results = await Promise.allSettled([owner.stop(terminate, abort.signal), event])
        const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
        if (this.failure) errors.push(this.failure)
        if (errors.length) throw new AggregateError(errors, "Terminal shell closure was not confirmed")
      } finally {
        clearTimeout(timer)
      }
    })())
  }
}
