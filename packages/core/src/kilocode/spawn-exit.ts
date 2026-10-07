import type { ChildProcess } from "effect/unstable/process"
import { Effect } from "effect"

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

export const cleanup = <E, R>(pid: number | undefined, next: Effect.Effect<void, E, R>) =>
  inactive(pid).pipe(Effect.flatMap((inactive) => (inactive ? Effect.void : next)))
