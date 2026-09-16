// Dev-only JSONL event trace for direct interactive mode.
//
// Enable with KILO_DIRECT_TRACE=1. Every synchronous write acquires process-local
// profile admission before resolving the current log root. A profile root change
// rotates the trace generation and atomically republishes direct/latest.json.
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Effect, Exit } from "effect"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live" // kilocode_change - profile migration admission

export type Trace = {
  write(type: string, data?: unknown): void
}

export type TraceDeps = {
  admission: ProfileWriterLive.Admission
  enabled(): boolean
  root(): string
  now(): Date
  pid(): number
  cwd(): string
  argv(): string[]
  mkdir(dir: string): void
  append(file: string, text: string): void
  publish(file: string, text: string): void
  warn(err: unknown): void
}

function stamp(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}

function text(data: unknown) {
  return JSON.stringify(
    data,
    (_key, value) => {
      if (typeof value === "bigint") return String(value)
      return value
    },
    0,
  )
}

export type PublishDeps = {
  pid: number
  id(): string
  write(file: string, value: string): void
  rename(source: string, target: string): void
  exists(file: string): boolean
  remove(file: string): void
}

export function publish(
  file: string,
  value: string,
  deps: PublishDeps = {
    pid: process.pid,
    id: () => crypto.randomUUID(),
    write: fs.writeFileSync,
    rename: fs.renameSync,
    exists: fs.existsSync,
    remove: fs.unlinkSync,
  },
) {
  const tmp = `${file}.${deps.pid}.${deps.id()}.tmp`
  try {
    deps.write(tmp, value)
    deps.rename(tmp, file)
  } finally {
    if (deps.exists(tmp)) deps.remove(tmp)
  }
}

const defaults: TraceDeps = {
  admission: ProfileWriterLive.diagnostics,
  enabled: () => Boolean(process.env.KILO_DIRECT_TRACE),
  root: () => Global.Path.log,
  now: () => new Date(),
  pid: () => process.pid,
  cwd: () => process.cwd(),
  argv: () => process.argv.slice(2),
  mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
  append: (file, value) => fs.appendFileSync(file, value),
  publish,
  warn: (err) => console.error("direct trace write dropped", err),
}

export function createTrace(deps: TraceDeps = defaults): Trace | undefined {
  if (!deps.enabled()) return

  let root: string | undefined
  let target: string | undefined
  let generation = 0
  let warned = false

  const trace: Trace = {
    write(type, data) {
      const result = Effect.runSyncExit(
        deps.admission.run(
          Effect.sync(() => {
            const next = deps.root()
            const rotate = root !== next || !target
            const file = (() => {
              if (!rotate && target) return target
              generation++
              const current = path.join(next, "direct")
              deps.mkdir(current)
              return path.join(current, `${stamp(deps.now())}-${deps.pid()}-${generation}.jsonl`)
            })()
            deps.append(
              file,
              text({
                time: deps.now().toISOString(),
                pid: deps.pid(),
                type,
                data,
              }) + "\n",
            )
            if (rotate) {
              const dir = path.join(next, "direct")
              deps.publish(
                path.join(dir, "latest.json"),
                text({
                  time: deps.now().toISOString(),
                  pid: deps.pid(),
                  cwd: deps.cwd(),
                  argv: deps.argv(),
                  path: file,
                }) + "\n",
              )
            }
            root = next
            target = file
          }),
        ),
      )
      if (Exit.isSuccess(result)) {
        warned = false
        return
      }
      if (warned) return
      warned = true
      deps.warn(result.cause)
    },
  }

  trace.write("trace.start", {
    argv: deps.argv(),
    cwd: deps.cwd(),
  })
  return trace
}

let state: Trace | false | undefined

export function trace(): Trace | undefined {
  if (state !== undefined) return state || undefined
  state = createTrace() ?? false
  return state || undefined
}
