import { Cause, Deferred, Effect, Exit, type Fiber } from "effect"
import type { Runner } from "@/effect/runner"
import { observe } from "./observation"
import { SessionRetirement } from "../session/retirement"

/** A joined finalizer defect is not proof that the selected work retired safely. */
export function interrupt<A, E>(fiber: Fiber.Fiber<A, E>) {
  return SessionRetirement.interrupt(fiber).pipe(
    Effect.flatMap((exit) =>
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
        ? Effect.failCause(exit.cause).pipe(Effect.orDie)
        : Effect.succeed(exit),
    ),
  )
}

/** Select and stop only a matching running handle inside the runner's state transaction. */
export function cancel<A, E>(
  state: Runner.State<A, E>,
  id: string,
  idle: Effect.Effect<void>,
  error: Runner.Cancelled,
): readonly [Effect.Effect<boolean>, Runner.State<A, E>] {
  if (state._tag !== "Running" || observe({ state }).id !== id) return [Effect.succeed(false), state]
  return [
    Effect.gen(function* () {
      const exit = yield* interrupt(state.run.fiber).pipe(
        Effect.ensuring(Deferred.fail(state.run.done, error).pipe(Effect.andThen(idle))),
      )
      return Exit.isFailure(exit)
    }),
    { _tag: "Idle" },
  ]
}
