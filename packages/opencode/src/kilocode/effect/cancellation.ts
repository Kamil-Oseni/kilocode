import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import type { Runner } from "@/effect/runner"
import { observe } from "./observation"

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
      yield* Fiber.interrupt(state.run.fiber)
      const exit = yield* Fiber.await(state.run.fiber)
      yield* Deferred.fail(state.run.done, error)
      yield* idle
      return Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
    }),
    { _tag: "Idle" },
  ]
}
