import fs from "node:fs"
import path from "node:path"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { KILO_PROCESS_ROLE } from "@opencode-ai/core/util/opencode-process"
import { Effect } from "effect"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"

export namespace HeapSnapshot {
  export type Input = {
    role?: string
  }

  export type Deps = {
    admission: ProfileWriterLive.Admission
    root(): string
    write(file: string): string
    now(): Date
    pid(): number
    role(): string
  }

  export type MonitorDeps = {
    enabled: boolean
    interval: number
    limit: number
    memory(): number
    schedule(run: () => void, interval: number): { clear(): void; unref?(): void }
    write(): Promise<string>
    warn(err: unknown): void
  }

  const defaults: Deps = {
    admission: ProfileWriterLive.diagnostics,
    root: () => Global.Path.log,
    write: writeHeapSnapshot,
    now: () => new Date(),
    pid: () => process.pid,
    role: () => process.env[KILO_PROCESS_ROLE] ?? "main",
  }

  let sequence = 0

  function safe(input: string) {
    return input.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "process"
  }

  export function generate(input: Input = {}, deps: Deps = defaults) {
    return deps.admission.run(
      Effect.try({
        try: () => {
          // Resolve the mutable profile root only after admission. The lease remains
          // held through native V8 serialization, which is synchronous and process-local.
          const root = deps.root()
          fs.mkdirSync(root, { recursive: true })
          const stamp = deps.now().toISOString().replace(/[:.]/g, "")
          const role = safe(input.role ?? deps.role())
          const count = String(++sequence).padStart(4, "0")
          const file = path.join(root, `heap-${role}-${deps.pid()}-${stamp}-${count}.heapsnapshot`)
          return deps.write(file)
        },
        catch: (err) => err,
      }),
    )
  }

  export function write(input: Input = {}, deps: Deps = defaults) {
    return Effect.runPromise(generate(input, deps))
  }

  export function monitor(deps: MonitorDeps) {
    let armed = true
    let stopped = false
    let pending: Promise<void> | undefined

    const tick = async () => {
      if (stopped || pending) return pending
      const rss = deps.memory()
      if (rss <= deps.limit) {
        armed = true
        return
      }
      if (!armed) return

      armed = false
      pending = deps
        .write()
        .then(() => undefined)
        .catch((err) => {
          // Admission can reopen without RSS dipping below the threshold.
          armed = true
          deps.warn(err)
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    }

    const timer = deps.enabled ? deps.schedule(() => void tick(), deps.interval) : undefined
    timer?.unref?.()

    return {
      tick,
      async stop() {
        stopped = true
        timer?.clear()
        await pending
      },
    }
  }

  const MINUTE = 60_000
  const LIMIT = 2 * 1024 * 1024 * 1024

  export function lifecycle(create: () => ReturnType<typeof monitor>) {
    let active: ReturnType<typeof monitor> | undefined
    let stopping: Promise<void> | undefined
    return {
      start() {
        if (active || stopping) return
        active = create()
      },
      stop() {
        if (stopping) return stopping
        const current = active
        if (!current) return Promise.resolve()
        active = undefined
        stopping = current.stop().finally(() => {
          stopping = undefined
        })
        return stopping
      },
    }
  }

  const automatic = lifecycle(() =>
    monitor({
      enabled: true,
      interval: MINUTE,
      limit: LIMIT,
      memory: () => process.memoryUsage().rss,
      schedule(run, interval) {
        const timer = setInterval(run, interval)
        return {
          clear: () => clearInterval(timer),
          unref: () => timer.unref?.(),
        }
      },
      write: () => write({ role: "automatic" }),
      warn: (err) => console.error("automatic heap snapshot failed", err),
    }),
  )

  export function start() {
    if (!Flag.KILO_AUTO_HEAP_SNAPSHOT) return
    automatic.start()
  }

  export function stop() {
    return automatic.stop()
  }
}
