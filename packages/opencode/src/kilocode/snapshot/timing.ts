import { Effect, Semaphore } from "effect"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Hash } from "@opencode-ai/core/util/hash"

const slow = 1_000

export namespace KiloSnapshotTiming {
  export const key = (gitdir: string) => Hash.fast(gitdir)

  export const lock = <A, R>(input: {
    op: string
    gitdir: string
    sem: Semaphore.Semaphore
    flock: EffectFlock.Interface
    effect: Effect.Effect<A, never, R>
  }) =>
    Effect.suspend(() => {
      const start = performance.now()
      const time = { semWait: 0, semHold: 0, flockWait: 0, flockHold: 0 }
      const entered = { sem: false, flock: false }
      return input.sem
        .withPermits(1)(
          Effect.suspend(() => {
            entered.sem = true
            time.semWait = performance.now() - start
            const held = performance.now()
            return input.flock
              .withLock(
                Effect.suspend(() => {
                  entered.flock = true
                  time.flockWait = performance.now() - held
                  const acquired = performance.now()
                  return input.effect.pipe(
                    Effect.ensuring(Effect.sync(() => (time.flockHold = performance.now() - acquired))),
                  )
                }),
                `snapshot:${input.gitdir}`,
              )
              .pipe(
                Effect.orDie,
                Effect.ensuring(
                  Effect.sync(() => {
                    if (!entered.flock) time.flockWait = performance.now() - held
                    time.semHold = performance.now() - held
                  }),
                ),
              )
          }),
        )
        .pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              if (!entered.sem) time.semWait = performance.now() - start
              if (Math.max(...Object.values(time)) < slow) return Effect.void
              return Effect.logWarning("slow snapshot lock", {
                op: input.op,
                key: key(input.gitdir),
                pid: process.pid,
                semWaitMs: Math.round(time.semWait),
                semHoldMs: Math.round(time.semHold),
                flockWaitMs: Math.round(time.flockWait),
                flockHoldMs: Math.round(time.flockHold),
              })
            }),
          ),
        )
    })

  export const git = (cmd: readonly string[], gitdir: string, start: number) => {
    const duration = performance.now() - start
    if (duration < slow) return Effect.void
    const verbs = new Set([
      "add",
      "cat-file",
      "check-ignore",
      "checkout",
      "checkout-index",
      "config",
      "diff",
      "diff-files",
      "gc",
      "init",
      "ls-files",
      "ls-tree",
      "read-tree",
      "rev-parse",
      "rm",
      "show",
      "status",
      "write-tree",
    ])
    return Effect.logWarning("slow snapshot git", {
      op: cmd.find((item) => verbs.has(item)) ?? "other",
      key: key(gitdir),
      pid: process.pid,
      durationMs: Math.round(duration),
    })
  }
}
