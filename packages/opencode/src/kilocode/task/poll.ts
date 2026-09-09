import { Cause, Duration, Effect } from "effect"

/** Report failed polls and keep the loop alive; interruption must still stop it. */
export function poll<A, E, R>(
  tick: Effect.Effect<A, E, R>,
  report: (cause: Cause.Cause<E>) => void,
  interval: Duration.Input = "60 seconds",
) {
  return tick.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.sync(() => report(cause)),
    ),
    Effect.andThen(Effect.sleep(interval)),
    Effect.forever,
  )
}
