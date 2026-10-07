import type { ChildProcess } from "effect/unstable/process"
import { Effect } from "effect"
import type { ChildProcess as Process } from "node:child_process"

const commands = new WeakSet<object>()

export function attach(command: ChildProcess.StandardCommand) {
  commands.add(command)
  return command
}

export function take(command: ChildProcess.StandardCommand) {
  const found = commands.has(command)
  commands.delete(command)
  return found
}

/** Admission only: this probe never supplies an exit code or settles original output. */
const inactive = (pid: number | undefined) =>
  Effect.suspend(() => {
    if (pid === undefined || pid <= 0) return Effect.succeed(false)
    return Effect.try({ try: () => process.kill(pid, 0), catch: (err) => err }).pipe(
      Effect.matchEffect({
        onSuccess: () => Effect.succeed(false),
        onFailure: (err) => {
          const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined
          if (code === "ESRCH") return Effect.succeed(true)
          return Effect.logDebug("Original process liveness query unavailable; retain ordinary cleanup", {
            code: typeof code === "string" ? code : "unknown",
          }).pipe(Effect.as(false))
        },
      }),
    )
  })

/** Let short commands retire through their original exit event before Windows tree cleanup. */
export const cleanup = <E, R>(proc: Process, next: Effect.Effect<void, E, R>) =>
  Effect.callback<boolean>((resume) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resume(Effect.succeed(true))
    const finish = (value: boolean) => {
      clearTimeout(timer)
      proc.off("exit", exited)
      resume(Effect.succeed(value))
    }
    const exited = () => finish(true)
    proc.once("exit", exited)
    // OS process retirement uses elapsed time, including under an injected Effect test clock.
    const timer = setTimeout(() => finish(false), 100)
    return Effect.sync(() => {
      clearTimeout(timer)
      proc.off("exit", exited)
    })
  }).pipe(
    Effect.flatMap((exit) =>
      exit ? Effect.void : inactive(proc.pid).pipe(Effect.flatMap((inactive) => (inactive ? Effect.void : next))),
    ),
  )
