import { Cause, Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import { RayaGoal } from "."

export namespace RayaGoalHealth {
  export type Summary = {
    goals: number
    active: number
    paused: number
    blocked: number
    failed: number
    incomplete: number
  }

  const limit = 256
  const decode = Schema.decodeUnknownEffect(RayaGoal.State)

  export const inspect = Effect.fn("RayaGoalHealth.inspect")(function* (
    storage: Pick<Storage.Interface, "list" | "read">,
  ) {
    const keys = yield* storage.list(["raya", "goal"])
    const states = yield* Effect.forEach(
      keys.slice(0, limit),
      (key) =>
        storage.read<unknown>(key).pipe(
          Effect.flatMap(decode),
          Effect.map((state) => state.status),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(undefined),
          ),
        ),
      { concurrency: 8 },
    )
    return {
      goals: keys.length,
      active: states.filter((status) => status === "active").length,
      paused: states.filter((status) => status === "paused").length,
      blocked: states.filter((status) => status === "blocked").length,
      failed: states.filter((status) => status === undefined).length,
      incomplete: Math.max(0, keys.length - limit),
    } satisfies Summary
  })
}
