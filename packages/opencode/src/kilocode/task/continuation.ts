import { Effect, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { Storage } from "@/storage/storage"
import { RayaTask } from "."
import { RayaTaskQueue } from "./queue"
import { scheduler } from "./scheduler"
import { inspect } from "./recovery"
import { isDeepStrictEqual } from "node:util"

export const record = Schema.Struct({
  version: Schema.Literals([1, 2]),
  agentID: Schema.String,
  runID: Schema.String,
  scheduleVersion: Schema.Number,
  trigger: RayaTask.Trigger,
})

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
    if (identity.trigger.kind !== "timer") {
      const claim = yield* inspect(input.storage, identity.agentID)
      if (!claim) return true
      if (
        claim.state !== "starting" ||
        !("runID" in claim) ||
        claim.runID !== identity.runID ||
        claim.sessionID !== input.session.id
      )
        return false
      const history = yield* RayaTask.make(input).runsFor(identity.agentID)
      return history.some(
        (run) =>
          run.id === identity.runID &&
          run.sessionID === input.session.id &&
          run.scheduleVersion === identity.scheduleVersion &&
          isDeepStrictEqual(run.trigger, identity.trigger) &&
          RayaTask.pending(run),
      )
    }
    if (!input.database) return false
    const row = yield* RayaTaskQueue.make(input.database).get(identity.trigger.id).pipe(Effect.orDie)
    // Timer metadata predates the queue. Preserve those legacy sessions when no queue identity exists.
    if (!row) return identity.version === 1
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
    return yield* scheduler({ storage: input.storage, database: input.database }).owned(run)
  })
}
