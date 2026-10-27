import { Effect, Option, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { Storage } from "@/storage/storage"
import { RayaTask } from "."
import { RayaTaskQueue } from "./queue"
import { scheduler } from "./scheduler"
import { inspect } from "./recovery"
import { isDeepStrictEqual } from "node:util"
import { RayaTaskExecution } from "./execution"
import { SessionID } from "@/session/schema"
import { Trigger } from "./trigger"
import { Outputs, pinned } from "./output-scope"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const record = Schema.Struct({
  version: Schema.Literals([1, 2]),
  agentID: Schema.String,
  runID: Schema.String,
  scheduleVersion: Schema.Number,
  trigger: Trigger,
  outputs: Schema.optional(Outputs),
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
    if (raw === undefined) {
      if (!input.database) return true
      return yield* Effect.gen(function* () {
        const module = yield* Effect.promise(() => import("./delegation"))
        const row = yield* module.RayaTaskDelegation.make(input.database!).bySession(input.session.id)
        if (!row) return true
        if (row.outputs !== undefined || !row.childRunID) return false
        const starts = yield* Effect.promise(() => import("./snapshot"))
        const saved = yield* starts.RayaTaskSnapshot.make(input).find(row.childRunID)
        return !!saved && saved.outputs === undefined
      }).pipe(Effect.catchCause(() => Effect.succeed(false)))
    }
    const identity = yield* Schema.decodeUnknownEffect(record)(raw).pipe(Effect.orElseSucceed(() => undefined))
    if (!identity) return false
    const scope = yield* Effect.gen(function* () {
      if (!identity.delegationID) {
        if (identity.outputs !== undefined) return false
        if (input.database) {
          const module = yield* Effect.promise(() => import("./delegation"))
          const row = yield* module.RayaTaskDelegation.make(input.database).bySession(input.session.id)
          if (row?.outputs !== undefined) return false
        }
        const starts = yield* Effect.promise(() => import("./snapshot"))
        const saved = yield* starts.RayaTaskSnapshot.make(input).find(identity.runID)
        return saved?.outputs === undefined
      }
      if (!input.database) return false
      const module = yield* Effect.promise(() => import("./delegation"))
      const row = yield* module.RayaTaskDelegation.make(input.database).get(identity.delegationID)
      const starts = yield* Effect.promise(() => import("./snapshot"))
      const saved = yield* starts.RayaTaskSnapshot.make(input).find(identity.runID)
      if (
        !saved ||
        row.recipientID !== identity.agentID ||
        row.childRunID !== identity.runID ||
        row.sessionID !== input.session.id ||
        row.organizationID !== identity.organizationID ||
        row.organizationRevision !== identity.organizationRevision ||
        (row.state !== "running" && row.state !== "needs_input") ||
        !isDeepStrictEqual(row.outputs, identity.outputs) ||
        !isDeepStrictEqual(saved.outputs, row.outputs)
      )
        return false
      if (row.outputs === undefined) return true
      const fs = yield* Effect.serviceOption(FSUtil.Service)
      if (Option.isNone(fs)) return false
      yield* pinned(fs.value, row.outputs)
      return true
    }).pipe(Effect.catchCause(() => Effect.succeed(false)))
    if (!scope) return false
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
  }).pipe(
    Effect.catchIf(
      (err): err is RayaTask.HistoryError => err instanceof RayaTask.HistoryError,
      () => Effect.succeed(false),
    ),
  )
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
    if (raw === undefined) return (yield* continuation(input)) ? yield* body : undefined
    const identity = yield* Schema.decodeUnknownEffect(record)(raw).pipe(Effect.orElseSucceed(() => undefined))
    if (!identity || !(yield* continuation(input))) return undefined
    const execution = RayaTaskExecution.make(input.storage)
    return yield* execution.enter(
      { id: identity.runID, agentID: identity.agentID, sessionID: SessionID.make(input.session.id) },
      body,
    )
  })
}
