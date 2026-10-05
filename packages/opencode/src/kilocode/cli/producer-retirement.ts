import { Cause, Effect, Exit } from "effect"
import { SessionRetirement } from "../session/retirement"
import { SnapshotRuntime } from "../snapshot/runtime"

/** Stop external intake first; accepted Session producers retain their Snapshot authority until actual Exit. */
export const drain = Effect.suspend(() => {
  SessionRetirement.fence()
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const periodic = yield* Effect.exit(SnapshotRuntime.quiesce())
      const producers = yield* Effect.exit(SessionRetirement.drain)
      if (Exit.isFailure(periodic) && Exit.isFailure(producers))
        yield* Effect.die(
          new AggregateError(
            [Cause.squash(periodic.cause), Cause.squash(producers.cause)],
            "Periodic and Session producer retirement failed",
          ),
        )
      if (Exit.isFailure(periodic)) yield* Effect.failCause(periodic.cause)
      if (Exit.isFailure(producers)) yield* Effect.failCause(producers.cause)
    }),
  )
})
