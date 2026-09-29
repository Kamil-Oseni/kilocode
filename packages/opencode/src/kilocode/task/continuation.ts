import { Effect, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { Storage } from "@/storage/storage"
import { RayaTask } from "."
import { RayaTaskQueue } from "./queue"
import { scheduler } from "./scheduler"
import { inspect } from "./recovery"
import { isDeepStrictEqual } from "node:util"
import { RayaTaskExecution } from "./execution"
import { SessionID } from "@/session/schema"

export const record = Schema.Struct({
  version: Schema.Literals([1, 2]),
  agentID: Schema.String,
  runID: Schema.String,
  scheduleVersion: Schema.Number,
  trigger: RayaTask.Trigger,
  delegationID: Schema.optional(Schema.String),
  organizationID: Schema.optional(Schema.String.check(Schema.isPattern(/^org_[a-f0-9]{32}$/))),
  organizationRevision: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  ),
}).check(
  Schema.makeFilter((value) =>
    (value.organizationID === undefined) === (value.organizationRevision === undefined)
      ? undefined
      : "Routine organization identity is incomplete.",
  ),
)

/** Check scheduled session identity before dispatching another automatic turn. */
export function continuation(input: {
  database?: Database.Interface
  storage: Storage.Interface
  session: { id: string; metadata?: Record<string, unknown> }
}): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const raw = input.session.metadata?.rayaRoutine
    if (raw === undefined) return true
    const identity = yield* Schema.decodeUnknownEffect(record)(raw).pipe(Effect.orElseSucceed(() => undefined))
    if (!identity) return false
    const execution = RayaTaskExecution.make(input.storage)
    const admit = (run: RayaTask.Run) =>
      execution.authorized(run).pipe(
        Effect.flatMap((owned) =>
          owned === undefined ? execution.acquire(run).pipe(Effect.map(Boolean)) : Effect.succeed(owned),
        ),
        Effect.catch(() => Effect.succeed(false)),
      )
    if (identity.trigger.kind !== "timer") {
      const history = yield* RayaTask.make(input).runsFor(identity.agentID)
      const run = history.find(
        (run) =>
          run.id === identity.runID &&
          run.sessionID === input.session.id &&
          run.scheduleVersion === identity.scheduleVersion &&
          isDeepStrictEqual(run.trigger, identity.trigger),
      )
      if (!run || !RayaTask.pending(run)) return false
      const claim = yield* inspect(input.storage, identity.agentID)
      if (!claim) return yield* admit(run)
      if (
        claim.state !== "starting" ||
        !("runID" in claim) ||
        claim.runID !== identity.runID ||
        claim.sessionID !== input.session.id
      )
        return false
      return yield* admit(run)
    }
    if (!input.database) return false
    const row = yield* RayaTaskQueue.make(input.database).get(identity.trigger.id).pipe(Effect.orDie)
    // Timer metadata predates the queue. Preserve exact pending legacy history under new execution ownership.
    if (!row) {
      if (identity.version !== 1) return false
      const history = yield* RayaTask.make(input).runsFor(identity.agentID)
      const run = history.find(
        (run) =>
          run.id === identity.runID &&
          run.sessionID === input.session.id &&
          run.scheduleVersion === identity.scheduleVersion &&
          isDeepStrictEqual(run.trigger, identity.trigger),
      )
      if (!run || !RayaTask.pending(run)) return false
      return yield* admit(run)
    }
    if (
      row.agent_id !== identity.agentID ||
      row.schedule_version !== identity.scheduleVersion ||
      row.claim_id !== identity.runID ||
      row.session_id !== input.session.id
    )
      return false
    const tasks = RayaTask.make(input)
    const history = yield* tasks.runsFor(identity.agentID)
    const run = history.find(
      (run) =>
        run.id === identity.runID &&
        run.sessionID === input.session.id &&
        run.scheduleVersion === identity.scheduleVersion &&
        run.trigger?.kind === "timer" &&
        run.trigger.id === row.id,
    )
    if (!run || !RayaTask.pending(run)) return false
    if (!(yield* scheduler({ storage: input.storage, database: input.database }).owned(run))) return false
    return yield* admit(run)
  })
}

/** Hold exact routine execution authority for the whole continuing body. Ordinary chats pass through unchanged. */
export function owned<A, E, R>(
  input: {
    database?: Database.Interface
    storage: Storage.Interface
    session: { id: string; metadata?: Record<string, unknown> }
  },
  body: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const raw = input.session.metadata?.rayaRoutine
    if (raw === undefined) return yield* body
    const identity = yield* Schema.decodeUnknownEffect(record)(raw).pipe(Effect.orElseSucceed(() => undefined))
    if (!identity || !(yield* continuation(input))) return undefined
    const execution = RayaTaskExecution.make(input.storage)
    return yield* execution.enter(
      { id: identity.runID, agentID: identity.agentID, sessionID: SessionID.make(input.session.id) },
      body,
    )
  })
}
