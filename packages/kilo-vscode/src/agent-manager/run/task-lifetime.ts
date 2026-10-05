import { TaskGone, type NativeTask } from "./task-native"

export type TaskExit = { exitCode?: number; error?: string }

/** Event arbitration shared by the real adapter and native lifetime regressions. */
export class TaskLifetime {
  private native: Promise<NativeTask> | undefined
  private exit: TaskExit | undefined
  private reported: number | undefined
  private failure: unknown
  private stopping: Promise<void> | undefined
  private grace: ReturnType<typeof setTimeout> | undefined
  private resolve: (exit: TaskExit) => void = () => undefined
  private readonly completion = new Promise<TaskExit>((resolve) => {
    this.resolve = resolve
  })

  constructor(
    private readonly done: (exit: TaskExit) => void,
    private readonly bind?: (pid: number) => Promise<NativeTask>,
  ) {}

  started(pid: number): void {
    if (!this.bind || this.native) return
    this.native = this.bind(pid)
    void this.native.catch((err: unknown) => {
      if (!(err instanceof TaskGone)) this.failure ??= err
    })
  }

  ended(code?: number): void {
    if (this.stopping && this.bind) return
    if (typeof code === "number") this.reported = code
    const finish = () =>
      this.finish(
        typeof this.reported === "number" ? { exitCode: this.reported } : { error: "Run task exit was not confirmed" },
      )
    if (!this.native) {
      finish()
      return
    }
    void this.native.then(finish, (err: unknown) => {
      if (err instanceof TaskGone && typeof this.reported === "number") {
        finish()
        return
      }
      this.failure ??= err
      this.finish({ error: "Run task exit was not confirmed" })
    })
  }

  end(): void {
    if (this.exit || this.stopping) return
    this.grace = setTimeout(() => this.ended(), 250)
  }

  stop(terminate: () => void): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.exit)
      return this.exit.error ? Promise.reject(this.failure ?? new Error(this.exit.error)) : Promise.resolve()
    if (this.grace) clearTimeout(this.grace)
    this.stopping = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = new AbortController()
      let work: Promise<void> | undefined
      try {
        work = this.bind
          ? (async () => {
              if (!this.native) throw new Error("Run task native start was not confirmed")
              const owner = await this.native
              this.finish({ exitCode: await owner.stop(terminate, abort.signal) })
            })()
          : (async () => {
              terminate()
              const exit = await this.completion
              if (exit.error) throw new Error(exit.error)
            })()
        await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort()
              if (!this.bind) this.finish({ error: "Run task exit was not confirmed" })
              reject(new Error("Run task stop was not confirmed"))
            }, 10000)
          }),
        ])
      } catch (err) {
        abort.abort()
        await work?.catch(() => undefined)
        this.finish({ error: "Run task exit was not confirmed" })
        throw err
      } finally {
        if (timer) clearTimeout(timer)
      }
    })()
    return this.stopping
  }

  dispose(): void {
    if (this.grace) clearTimeout(this.grace)
  }

  private finish(exit: TaskExit): void {
    if (this.exit) return
    this.exit = exit
    this.dispose()
    this.resolve(exit)
    this.done(exit)
  }
}
