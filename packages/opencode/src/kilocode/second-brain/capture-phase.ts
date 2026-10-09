import { Cause, Effect } from "effect"

/** Only preparation failures may close an unused grant; dispatch owns every later uncertainty. */
export const stage = Effect.fn("SecondBrain.captureStage")(function* <A, E, R, B, F, S>(
  prepare: Effect.Effect<A, E, R>,
  failed: (cause: Cause.Cause<E>) => Effect.Effect<unknown, F, S>,
  dispatch: (value: A) => Effect.Effect<B, F, S>,
) {
  const value = yield* prepare.pipe(
    Effect.onError((cause) =>
      failed(cause).pipe(
        Effect.catchCause((next) =>
          Effect.die(
            new AggregateError(
              [Cause.squash(cause), Cause.squash(next)],
              "Original extraction and failure disposition both failed",
            ),
          ),
        ),
      ),
    ),
  )
  return yield* dispatch(value)
})
