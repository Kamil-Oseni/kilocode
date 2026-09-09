import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
export const Source = Schema.Struct({ root: Schema.String, commit: Schema.String })
export const Phase = Schema.Literals([
  "reserved",
  "session_creating",
  "session_created",
  "goal_creating",
  "goal_created",
  "dispatching",
  "submitted",
  "blocked",
  "dispatch_unknown",
  "legacy_conflict",
])
export const Outcome = Schema.Struct({
  id: Schema.String,
  itemID: Schema.String,
  source: Source,
  phase: Phase,
  revision: Schema.Number,
  sessionID: Schema.optional(SessionID),
  reason: Schema.optional(Schema.String),
  at: Schema.Number,
})
export const Admission = Schema.Struct({ source: Source })
export const Granted = Schema.Struct({ owned: Schema.Boolean, outcome: Outcome, token: Schema.optional(Schema.String) })
export const Advance = Schema.Struct({
  token: Schema.String,
  revision: Schema.Number,
  phase: Phase,
  sessionID: Schema.optional(SessionID),
})
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SelfHeal.RepairConflict", {
  message: Schema.String,
}) {}
const Claim = Schema.Struct({ outcome: Outcome, owner: Schema.String })
const decode = Schema.decodeUnknownEffect(Claim)
const stages: Partial<Record<typeof Phase.Type, typeof Phase.Type>> = {
  reserved: "session_creating",
  session_creating: "session_created",
  session_created: "goal_creating",
  goal_creating: "goal_created",
  goal_created: "dispatching",
  dispatching: "submitted",
}
const reason = (phase: typeof Phase.Type) =>
  phase === "dispatch_unknown"
    ? "Dispatch may have started. Inspect the linked session; do not replay automatically."
    : "Repair startup stopped. Inspect the retained attempt and any linked session before recovery."

export function repairs(storage: Pick<Storage.Interface, "read" | "create">) {
  const key = (id: string, revision: number) => ["raya", "self-heal", "repair", digest(id), String(revision)]
  const read = Effect.fn(function* (id: string) {
    const first = yield* storage.read<unknown>(key(id, 0)).pipe(
      Effect.flatMap(decode),
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      Effect.orDie,
    )
    if (!first) return
    let claim = first
    for (let revision = 1; revision <= 8; revision++) {
      const next = yield* storage.read<unknown>(key(id, revision)).pipe(
        Effect.flatMap(decode),
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
        Effect.orDie,
      )
      if (!next) return claim
      claim = next
    }
    return claim
  })
  const get = Effect.fn(function* (id: string) {
    return (yield* read(id))?.outcome
  })
  const admit = Effect.fn(function* (id: string, source: typeof Source.Type, conflict: boolean) {
    const token = crypto.randomUUID()
    const outcome: typeof Outcome.Type = {
      id: crypto.randomUUID(),
      itemID: id,
      source,
      phase: conflict ? "legacy_conflict" : "reserved",
      revision: 0,
      at: Date.now(),
      ...(conflict
        ? {
            reason:
              "Existing repair linkage or conflicting legacy reports require reconciliation. No new repair was started.",
          }
        : {}),
    }
    const owned = yield* storage.create(key(id, 0), { owner: digest(token), outcome }).pipe(Effect.orDie)
    if (!owned) return { owned: false, outcome: (yield* read(id))!.outcome }
    return { owned: !conflict, outcome, ...(conflict ? {} : { token }) }
  })
  const advance = Effect.fn(function* (id: string, input: typeof Advance.Type) {
    const claim = yield* read(id)
    if (!claim || claim.owner !== digest(input.token) || claim.outcome.revision !== input.revision)
      return yield* new Conflict({
        message: "Repair ownership or phase changed. Read the retained outcome before recovery.",
      })
    const previous = claim.outcome
    const failure = input.phase === "blocked" || input.phase === "dispatch_unknown"
    if (
      failure
        ? !stages[previous.phase] || (previous.phase === "dispatching") !== (input.phase === "dispatch_unknown")
        : stages[previous.phase] !== input.phase
    )
      return yield* new Conflict({ message: "Invalid repair transition." })
    if (
      input.phase === "session_created"
        ? !input.sessionID
        : input.sessionID !== undefined && input.sessionID !== previous.sessionID
    )
      return yield* new Conflict({ message: "Repair session identity cannot change." })
    const outcome: typeof Outcome.Type = {
      ...previous,
      phase: input.phase,
      revision: previous.revision + 1,
      sessionID: input.sessionID ?? previous.sessionID,
      at: Date.now(),
      ...(failure ? { reason: `Startup stopped at ${previous.phase}. ${reason(input.phase)}` } : {}),
    }
    if (!(yield* storage.create(key(id, outcome.revision), { owner: claim.owner, outcome }).pipe(Effect.orDie)))
      return yield* new Conflict({ message: "Another caller already advanced this repair." })
    return outcome
  })
  return { get, admit, advance }
}
