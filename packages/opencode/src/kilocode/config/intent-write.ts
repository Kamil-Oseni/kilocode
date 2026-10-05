import { Cause, Effect, Exit } from "effect"
import { ConfigIntent } from "@opencode-ai/core/kilocode/config-intent"

/** Join the accepted native write and bind its exact predecessor before recording a revision. */
export function intentWrite<A, E, R>(body: Effect.Effect<A, E, R>, file: string, before: string, after: string) {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const ticket = yield* Effect.promise(() => ConfigIntent.writing(file, before, after))
      const result = yield* body.pipe(Effect.exit)
      if (Exit.isFailure(result)) {
        ticket.fail(Cause.squash(result.cause))
        return yield* Effect.failCause(result.cause)
      }
      yield* Effect.promise(() => ticket.complete())
      return result.value
    }),
  )
}
