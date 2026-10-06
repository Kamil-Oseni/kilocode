import { Cause, Effect, Exit } from "effect"
import { MemoryContract } from "@kilocode/kilo-memory/effect/httpapi"
import { MemoryInvalidInputError } from "@kilocode/kilo-memory/effect/errors"

export type Records = Map<string, typeof MemoryContract.DreamInspection.Type>

/** Ephemeral original-backend receipts, never note content or proof of native inference retirement. */
export function track<A, E, R>(
  records: Records,
  input: Pick<typeof MemoryContract.DreamGeneratePayload.Type, "id" | "owner" | "model">,
  work: Effect.Effect<A, E, R>,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (records.has(input.id))
        return yield* Effect.fail(
          new MemoryInvalidInputError({ reason: "Inspect the original Dream request; do not replay it" }),
        )
      if ([...records.values()].some((item) => item.settlement === "pending"))
        return yield* Effect.fail(new MemoryInvalidInputError({ reason: "The original Dream request has not settled" }))
      if (records.size >= 32) records.delete(records.keys().next().value!)
      const entry: typeof MemoryContract.DreamInspection.Type = {
        id: input.id,
        owner: input.owner,
        configuredModel: input.model,
        settlement: "pending",
        outcome: "running",
        startedAt: Date.now(),
      }
      records.set(entry.id, entry)
      return yield* restore(work).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            records.set(entry.id, {
              ...entry,
              settlement: "sdk",
              outcome: Exit.isSuccess(exit) ? "completed" : Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed",
              settledAt: Date.now(),
            })
          }),
        ),
      )
    }),
  )
}

export function inspect(records: Records, input: typeof MemoryContract.DreamInspectPayload.Type) {
  const entry = records.get(input.id)
  if (!entry || entry.owner !== input.owner)
    return Effect.fail(new MemoryInvalidInputError({ reason: "Original Dream request is unavailable on this backend" }))
  return Effect.succeed({ ...entry })
}
