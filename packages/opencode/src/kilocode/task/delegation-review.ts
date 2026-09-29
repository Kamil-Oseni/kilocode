import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000))
const Time = Schema.Int.check(Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }))
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Context = Schema.Struct({ intent: Name, source: Name, execution: Digest })
type Context = typeof Context.Type
export const Snapshot = Schema.Struct({
  id: Name,
  source: Name,
  senderID: Name,
  recipientID: Name,
  parentID: Schema.optional(Name),
  parentRunID: Schema.optional(Name),
  organizationID: Schema.optional(Name),
  organizationName: Schema.optional(Name),
  organizationRevision: Schema.optional(Schema.Int),
  workspace: Schema.optional(Schema.String),
  objective: Name,
  expected: Schema.optional(Name),
  context: Schema.optional(Name),
  deadline: Schema.optional(Time),
  budget: Schema.optional(Schema.Number),
  depth: Schema.Int,
  state: Schema.Literals(["needs_input", "running"]),
  childRunID: Name,
  sessionID: Name,
  artifacts: Schema.optional(Schema.Unknown),
  response: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
  time: Time,
  updated: Time,
})
export type Snapshot = typeof Snapshot.Type
export const Journal = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals(["prepared", "cas", "complete"]),
  runID: Name,
  sessionID: Name,
  review: Context,
  prior: Snapshot,
  target: Schema.Struct({ updated: Time }),
  at: Time,
  updatedAt: Time,
})
export type Journal = typeof Journal.Type
class JournalError extends Schema.TaggedErrorClass<JournalError>()("RayaTaskDelegationReview.Error", {
  message: Schema.String,
}) {}
type Store = Pick<Storage.Interface, "read" | "create" | "replace" | "remove">
const key = (id: string) => ["raya", "delegation-reviews", createHash("sha256").update(id).digest("hex")]

export function ledger(storage: Store) {
  const load = (id: string) =>
    storage.read<unknown>(key(id)).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed(undefined)
          : Schema.decodeUnknownEffect(Journal)(value).pipe(
              Effect.mapError(() => new JournalError({ message: "This delegation has an invalid recovery journal." })),
            ),
      ),
    )
  const prepare = Effect.fn("RayaTaskDelegationReview.prepare")(function* (input: {
    runID: string
    sessionID: string
    review: Context
    prior: Snapshot
    updated: number
  }) {
    const saved = yield* load(input.prior.id)
    if (saved) {
      const changed =
        saved.runID !== input.runID ||
        saved.sessionID !== input.sessionID ||
        !isDeepStrictEqual(saved.review, input.review) ||
        !isDeepStrictEqual(saved.prior, input.prior)
      if (changed && saved.phase !== "complete")
        return yield* new JournalError({ message: "This delegation recovery journal changed." })
      if (!changed) return saved
    }
    const now = Date.now()
    const journal: Journal = {
      version: 1,
      phase: "prepared",
      runID: input.runID,
      sessionID: input.sessionID,
      review: input.review,
      prior: input.prior,
      target: { updated: input.updated },
      at: now,
      updatedAt: now,
    }
    if (saved) yield* storage.replace(key(input.prior.id), journal).pipe(Effect.orDie)
    else if (!(yield* storage.create(key(input.prior.id), journal).pipe(Effect.orDie)))
      return yield* new JournalError({ message: "This delegation recovery journal changed during preparation." })
    return journal
  })
  const replace = Effect.fn("RayaTaskDelegationReview.replace")(function* (prior: Journal, next: Journal) {
    const saved = yield* load(prior.prior.id)
    if (!saved || !isDeepStrictEqual(saved, prior))
      return yield* new JournalError({ message: "This delegation recovery journal changed during settlement." })
    yield* storage.replace(key(prior.prior.id), next).pipe(Effect.orDie)
    return next
  })
  const finish = (id: string) => storage.remove(key(id))
  return { load, prepare, replace, finish }
}
