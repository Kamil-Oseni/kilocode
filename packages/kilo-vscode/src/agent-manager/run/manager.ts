export type RunState = "idle" | "running" | "stopping"

export interface RunStatus {
  worktreeId: string
  state: RunState
  exitCode?: number
  stopped?: boolean
  signal?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

export interface RunHandle {
  stop(): void | Promise<void>
  /**
   * Kill the process but retain the terminal as failed with its output,
   * instead of dropping it (stop). Used for timeouts, where the partial
   * output must stay reviewable.
   */
  kill?(reason: string): void
  dispose?(): void
}

interface Entry {
  status: RunStatus
  handle?: RunHandle
  task?: Promise<RunHandle>
  released?: boolean
  stopping?: Promise<void>
}

interface FinishOptions {
  exitCode?: number
  stopped?: boolean
  signal?: string
  error?: string
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export class RunScriptManager {
  private entries = new Map<string, Entry>()
  private removed = new Set<string>()
  private retired = false
  private closing: Promise<void> | undefined
  private readonly failures: unknown[] = []

  constructor(
    private readonly log: (msg: string) => void,
    private readonly emit: (status: RunStatus) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(worktreeId: string, start: () => Promise<RunHandle>): Promise<boolean> {
    if (this.retired) throw new Error("Run script intake is retired")
    this.removed.delete(worktreeId)
    const current = this.entries.get(worktreeId)
    if (current && current.status.state !== "idle") return false

    const entry: Entry = {
      status: {
        worktreeId,
        state: "running",
        startedAt: this.now().toISOString(),
      },
    }
    this.entries.set(worktreeId, entry)
    this.emit(entry.status)

    try {
      const task = start()
      entry.task = task
      const handle = await task
      const latest = this.entries.get(worktreeId)
      if (latest !== entry) {
        await this.release(worktreeId, entry, handle, this.removed.has(worktreeId))
        return true
      }
      entry.handle = handle
      if (entry.status.state === "stopping") {
        void this.halt(worktreeId, entry, handle)
      }
    } catch (error) {
      this.failures.push(error)
      this.finish(worktreeId, { error: message(error) })
    }
    return true
  }

  async stop(worktreeId: string): Promise<void> {
    const entry = this.entries.get(worktreeId)
    if (!entry || entry.status.state === "idle" || entry.status.state === "stopping") return

    entry.status = {
      ...entry.status,
      state: "stopping",
    }
    this.emit(entry.status)

    if (!entry.handle) return
    await this.halt(worktreeId, entry, entry.handle)
  }

  finish(worktreeId: string, opts: FinishOptions = {}): void {
    if (this.removed.has(worktreeId)) return
    if (opts.error) this.failures.push(new Error(opts.error))
    const entry = this.entries.get(worktreeId)
    entry?.handle?.dispose?.()

    const status: RunStatus = {
      worktreeId,
      state: "idle",
      finishedAt: this.now().toISOString(),
    }
    if (entry?.status.startedAt) status.startedAt = entry.status.startedAt
    if (opts.exitCode !== undefined) status.exitCode = opts.exitCode
    if (opts.stopped) status.stopped = true
    if (opts.signal) status.signal = opts.signal
    if (opts.error) status.error = opts.error

    this.entries.set(worktreeId, { status })
    this.emit(status)
  }

  status(worktreeId: string): RunStatus {
    return this.entries.get(worktreeId)?.status ?? { worktreeId, state: "idle" }
  }

  all(): RunStatus[] {
    return [...this.entries.values()].map((entry) => entry.status)
  }

  async remove(worktreeId: string): Promise<void> {
    const entry = this.entries.get(worktreeId)
    this.removed.add(worktreeId)
    this.entries.delete(worktreeId)
    const handle =
      entry?.handle ??
      (entry?.task
        ? await entry.task.catch((error) => {
            this.log(`Failed to start removed run script for ${worktreeId}: ${message(error)}`)
            return undefined
          })
        : undefined)
    if (!entry || !handle) return
    if (entry.status.state !== "idle") {
      await this.release(worktreeId, entry, handle, true)
      return
    }
    await this.release(worktreeId, entry, handle, false)
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing
    this.retired = true
    this.closing = (async () => {
      const results = await Promise.allSettled(
        [...this.entries].map(async ([id, entry]) => {
          this.removed.add(id)
          const handle = entry.handle ?? (await entry.task)
          if (handle) await this.release(id, entry, handle, entry.status.state !== "idle")
        }),
      )
      const errors = [
        ...this.failures,
        ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ]
      if (errors.length) throw new AggregateError(errors, "Run script retirement failed")
      this.entries.clear()
    })()
    return this.closing
  }

  private async release(worktreeId: string, entry: Entry, handle: RunHandle, stop: boolean): Promise<void> {
    if (entry.released) return
    entry.released = true
    if (stop) await this.halt(worktreeId, entry, handle)
    handle.dispose?.()
  }

  private halt(worktreeId: string, entry: Entry, handle: RunHandle): Promise<void> {
    if (entry.stopping) return entry.stopping
    const task = (() => {
      try {
        return Promise.resolve(handle.stop())
          .then(() => undefined)
          .catch((error) => {
            this.failures.push(error)
            this.log(`Failed to stop run script for ${worktreeId}: ${message(error)}`)
          })
      } catch (error) {
        this.failures.push(error)
        this.log(`Failed to stop run script for ${worktreeId}: ${message(error)}`)
        return Promise.resolve()
      }
    })()
    entry.stopping = task
    return task
  }
}
