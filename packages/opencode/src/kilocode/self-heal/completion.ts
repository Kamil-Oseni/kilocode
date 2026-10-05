import { Completions as Data } from "./schemas"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { Conflict, type repairs } from "./repair"
import { Assessment } from "./verification"

export const Completion = Data.Completion
const identity = (goal: typeof Data.Goal.Type) =>
  JSON.stringify({
    ...goal,
    completedRevision: undefined,
    audit: {
      ...goal.audit,
      verifiedAt: 0,
      requirements: goal.audit.requirements.map((row) => ({
        ...row,
        evidence: row.evidence.map((ref) => ({ ...ref, record: { ...ref.record, at: 0 } })),
      })),
    },
    review: goal.review ? { ...goal.review, acceptedAt: 0 } : undefined,
  })
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

export function completions(storage: Pick<Storage.Interface, "read" | "create">, repair: ReturnType<typeof repairs>) {
  const key = (id: string) => ["raya", "self-heal", "completion", hash(id)]
  const get = Effect.fn(function* (id: string) {
    return yield* storage.read<unknown>(key(id)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Completion)),
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      Effect.orDie,
    )
  })
  const link = Effect.fn(function* (id: string, sessionID: SessionID, attempt?: string) {
    const outcome = yield* repair.get(id)
    if (
      !outcome?.worktree ||
      outcome.sessionID !== sessionID ||
      (attempt !== undefined && outcome.id !== attempt) ||
      !["goal_creating", "goal_created", "dispatching", "submitted", "dispatch_unknown"].includes(outcome.phase)
    )
      return yield* new Conflict({ message: "This goal is not owned by the retained repair attempt and session." })
    return outcome
  })
  // Internal capability: only the goal service calls this after its evidence and human-review gates.
  // No HTTP route accepts a receipt or invokes this publication boundary.
  const record = Effect.fn(function* (
    id: string,
    sessionID: SessionID,
    attempt: string,
    input: unknown,
    verification?: typeof Assessment.Type,
  ) {
    const outcome = yield* link(id, sessionID, attempt)
    if (!["dispatching", "submitted", "dispatch_unknown"].includes(outcome.phase))
      return yield* new Conflict({ message: "Repair dispatch has not reached a completion-eligible phase." })
    const goal = yield* Schema.decodeUnknownEffect(Data.Goal)(input).pipe(
      Effect.mapError(() => new Conflict({ message: "Completion requires a fully identified, accepted goal audit." })),
    )
    const receipt: typeof Completion.Type = {
      version: 1,
      itemID: id,
      attemptID: attempt,
      sessionID,
      source: outcome.source,
      worktree: outcome.worktree!,
      goal,
      verification,
      at: Date.now(),
    }
    if (yield* storage.create(key(id), receipt).pipe(Effect.orDie)) return receipt
    const existing = yield* get(id)
    if (
      existing?.attemptID !== attempt ||
      existing.sessionID !== sessionID ||
      identity(existing.goal) !== identity(goal)
    )
      return yield* new Conflict({
        message: "A different tested-completion receipt is already retained. Inspect it before recovery.",
      })
    return existing
  })
  return { get, link, record }
}
