import { Effect } from "effect"
import { Refusal } from "../session/tool-refusal"

const held = new Map<string, object>()

/** Own the entire same-child invocation before reading its mutable continuation proof. */
export function admit<A, E, R>(child: string | undefined, body: Effect.Effect<A, E, R>) {
  if (!child) return body
  const key = child
  return Effect.acquireUseRelease(
    Effect.suspend(() => {
      if (held.has(key))
        return Effect.fail(
          new Refusal(
            "task-concurrent",
            "This task already has an admitted call. Let that call finish before continuing the same task.",
          ),
        )
      const token = Object.freeze({})
      held.set(key, token)
      return Effect.succeed(token)
    }),
    () => body,
    (token) =>
      Effect.sync(() => {
        if (held.get(key) !== token) throw new Error("Task admission ownership changed")
        held.delete(key)
      }),
  )
}
