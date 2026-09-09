import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { Storage } from "@/storage/storage"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import * as Checkout from "./worktree"
import { SessionID } from "@/session/schema"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
export const Source = Schema.Struct({ root: Schema.String, commit: Schema.String })
export const Phase = Schema.Literals([
  "reserved",
  "worktree_creating",
  "worktree_ready",
  "worktree_unknown",
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
  worktree: Schema.optional(Checkout.Worktree),
  phase: Phase,
  revision: Schema.Number,
  sessionID: Schema.optional(SessionID),
  reason: Schema.optional(Schema.String),
  at: Schema.Number,
})
export const Admission = Schema.Struct({ source: Source })
export const Granted = Schema.Struct({ owned: Schema.Boolean, outcome: Outcome, token: Schema.optional(Schema.String) })
export const Prepare = Schema.Struct({ token: Schema.String, revision: Schema.Number })
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
  reserved: "worktree_creating",
  worktree_creating: "worktree_ready",
  worktree_ready: "session_creating",
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

export function repairs(
  storage: Pick<Storage.Interface, "read" | "create">,
  root = path.join(Global.Path.data, "raya", "repair-worktrees"),
) {
  const key = (id: string, revision: number) => ["raya", "self-heal", "repair", digest(id), String(revision)]
  const read = Effect.fn(function* (id: string) {
    const first = yield* storage.read<unknown>(key(id, 0)).pipe(
      Effect.flatMap(decode),
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      Effect.orDie,
    )
    if (!first) return
    let claim = first
    for (let revision = 1; revision <= 12; revision++) {
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
    if (["worktree_creating", "worktree_ready", "worktree_unknown"].includes(input.phase))
      return yield* new Conflict({ message: "Worktree phases require owned preparation." })
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
    if (input.phase === "session_creating" || input.phase === "dispatching") {
      const valid =
        previous.worktree &&
        (yield* Effect.tryPromise(() => Checkout.verify(previous.source, previous.worktree!)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ))
      if (!valid) {
        const blocked: typeof Outcome.Type = {
          ...previous,
          phase: "blocked",
          revision: previous.revision + 1,
          at: Date.now(),
          reason: `Repair checkout verification failed before ${input.phase}. Inspect the retained directory and source; no dependent operation was authorized.`,
        }
        if (
          !(yield* storage
            .create(key(id, blocked.revision), { owner: claim.owner, outcome: blocked })
            .pipe(Effect.orDie))
        )
          return yield* new Conflict({ message: "Another caller already advanced this repair." })
        return blocked
      }
    }
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
  const prepare = Effect.fn(function* (id: string, input: typeof Prepare.Type) {
    const claim = yield* read(id)
    if (
      !claim ||
      claim.owner !== digest(input.token) ||
      claim.outcome.revision !== input.revision ||
      claim.outcome.phase !== "reserved"
    )
      return yield* new Conflict({ message: "Repair checkout preparation is already owned or needs inspection." })
    const planning = yield* Effect.tryPromise({
      try: () => Checkout.plan(claim.outcome.source, claim.outcome.id, root),
      catch: (error) =>
        error instanceof Checkout.Unsupported
          ? error.message
          : "Repair source or managed directory could not be verified. Inspect the source identity and local Git configuration before recovery.",
    }).pipe(
      Effect.match({
        onSuccess: (worktree) => ({ worktree, reason: undefined }),
        onFailure: (reason) => ({ worktree: undefined, reason }),
      }),
    )
    if (!planning.worktree) {
      const outcome: typeof Outcome.Type = {
        ...claim.outcome,
        phase: "blocked",
        revision: claim.outcome.revision + 1,
        at: Date.now(),
        reason: planning.reason,
      }
      if (!(yield* storage.create(key(id, outcome.revision), { owner: claim.owner, outcome }).pipe(Effect.orDie)))
        return yield* new Conflict({ message: "Another caller already advanced this repair." })
      return outcome
    }
    const planned = planning.worktree
    const creating: typeof Outcome.Type = {
      ...claim.outcome,
      worktree: planned,
      phase: "worktree_creating",
      revision: claim.outcome.revision + 1,
      at: Date.now(),
    }
    if (
      !(yield* storage.create(key(id, creating.revision), { owner: claim.owner, outcome: creating }).pipe(Effect.orDie))
    )
      return yield* new Conflict({ message: "Another caller owns checkout creation." })
    const ready = yield* Effect.tryPromise(() => Checkout.create(creating.source, planned)).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    const outcome: typeof Outcome.Type = {
      ...creating,
      phase: ready ? "worktree_ready" : "worktree_unknown",
      revision: creating.revision + 1,
      at: Date.now(),
      ...(!ready
        ? {
            reason:
              "Repair checkout creation could not be confirmed. The recorded branch and directory remain reserved; inspect them without retrying or removing them automatically.",
          }
        : {}),
    }
    if (!(yield* storage.create(key(id, outcome.revision), { owner: claim.owner, outcome }).pipe(Effect.orDie)))
      return yield* new Conflict({ message: "Repair checkout completion could not be recorded." })
    return outcome
  })
  return { get, admit, advance, prepare }
}
