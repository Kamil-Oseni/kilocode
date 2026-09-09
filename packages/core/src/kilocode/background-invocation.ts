import { Cause, Deferred, Effect, SynchronizedRef } from "effect"

class Cancelled extends Error {
  constructor() {
    super("Task invocation cancelled")
  }
}

export const cancelled = (cause: Cause.Cause<unknown>) =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) => Cause.isFailReason(reason) && reason.error instanceof Cancelled)

export const make = Effect.gen(function* () {
  const signal = yield* Deferred.make<void>()
  const done = yield* Deferred.make<void>()
  const state = yield* SynchronizedRef.make({ started: false, finished: false, cancelled: false })
  return {
    run: (work: Effect.Effect<string, unknown>) =>
      Effect.gen(function* () {
        const admitted = yield* SynchronizedRef.modify(state, (current) =>
          current.cancelled ? [false, current] : [true, { ...current, started: true }],
        )
        if (!admitted) return yield* Effect.fail(new Cancelled())
        return yield* Effect.raceFirst(work, Deferred.await(signal).pipe(Effect.andThen(Effect.fail(new Cancelled()))))
      }).pipe(
        Effect.ensuring(
          SynchronizedRef.update(state, (current) => ({ ...current, finished: true })).pipe(
            Effect.andThen(Deferred.succeed(done, undefined)),
          ),
        ),
      ),
    // Selection never waits for cleanup. Its caller releases the registry lock before waiting.
    request: SynchronizedRef.modifyEffect(state, (current) =>
      Effect.gen(function* () {
        if (current.finished) return [Effect.succeed(false), current] as const
        yield* Deferred.succeed(signal, undefined)
        const wait = current.started ? Deferred.await(done).pipe(Effect.as(true)) : Effect.succeed(true)
        return [wait, { ...current, cancelled: true }] as const
      }),
    ),
  }
})

export type Control = Effect.Success<typeof make>
