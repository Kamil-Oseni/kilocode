import { Cause, Effect, Scope } from "effect"

/** Preserve the body Exit separately from the actual joined scope-close Exit. */
export function settle<A, E, R>(body: Effect.Effect<A, E, R>) {
  const errors = <E>(cause: Cause.Cause<E>) => cause.reasons.map((reason) => Cause.squash(Cause.fromReasons([reason])))
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const result = yield* Effect.exit(restore(Scope.provide(scope)(body)))
      const cleanup = yield* Effect.exit(Scope.close(scope, result))
      const failures = [
        ...(result._tag === "Failure" ? errors(result.cause) : []),
        ...(cleanup._tag === "Failure" ? errors(cleanup.cause) : []),
      ]
      if (failures.length > 1)
        return yield* Effect.die(new AggregateError(failures, "TUI body and scope finalizers failed"))
      if (cleanup._tag === "Failure") return yield* Effect.failCause(cleanup.cause)
      if (result._tag === "Failure") return yield* Effect.failCause(result.cause)
      return result.value
    }),
  )
}
