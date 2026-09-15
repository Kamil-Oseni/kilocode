import { Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { Database } from "@opencode-ai/core/database/database"
import type { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTask } from "."
import { RayaTaskQueue } from "./queue"
import { RayaTaskDelegation } from "./delegation"
import { RayaTaskInbox } from "./inbox"
import { record } from "./continuation"
import { recover } from "./recovery"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { sql } from "drizzle-orm"
import { SessionID } from "@/session/schema"

/** Repair persisted links/history; recovering a stopped claim must not repeat session or model work. */
export function reconcile(input: {
  database: Database.Interface
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "get" | "messages" | "children">
}) {
  const tasks = RayaTask.make(input)
  const goals = RayaGoal.make(input)
  const queue = RayaTaskQueue.make(input.database)
  const errands = RayaTaskDelegation.make(input.database)
  const inbox = RayaTaskInbox.make(input.database)
  const inspect = Effect.fn("RayaTaskRecovery.inspect")(function* (
    claim: Parameters<Parameters<typeof recover>[2]>[0],
  ) {
    if (claim.phase === "session-created" && !claim.sessionID) return undefined
    if (claim.messageSource || claim.messageSessionID) {
      if (!claim.messageSource || !claim.messageSessionID || !claim.sessionID) return undefined
      const session = yield* input.sessions.get(claim.sessionID).pipe(Effect.orElseSucceed(() => undefined))
      if (!session || session.id !== claim.sessionID) return undefined
      const identity = yield* Schema.decodeUnknownEffect(record)(session.metadata?.rayaRoutine).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (
        !identity ||
        identity.trigger.kind === "timer" ||
        identity.agentID !== claim.agentID ||
        identity.runID !== claim.id ||
        claim.trigger === undefined ||
        !isDeepStrictEqual(claim.trigger, identity.trigger)
      )
        return undefined
      if (!(yield* tasks.list()).some((item) => item.id === claim.agentID)) return undefined
      const goal = yield* goals.get(claim.sessionID)
      if (!goal || goal.status !== "active") return undefined
      const history = yield* tasks.runsFor(claim.agentID)
      const prior = history.find((run) => run.id === claim.id)
      const run: RayaTask.Run = {
        id: claim.id,
        agentID: claim.agentID,
        sessionID: claim.sessionID,
        at: claim.at,
        scheduleVersion: identity.scheduleVersion,
        trigger: identity.trigger,
        status: "running",
      }
      if (
        prior &&
        (prior.sessionID !== run.sessionID ||
          prior.at !== run.at ||
          prior.scheduleVersion !== run.scheduleVersion ||
          !isDeepStrictEqual(prior.trigger, run.trigger) ||
          !RayaTask.pending(prior))
      )
        return undefined
      const state = yield* inbox.movable(claim.agentID, claim.messageSource, claim.messageSessionID, claim.sessionID)
      if (!state) return undefined
      return { kind: "message" as const, run, source: claim.messageSource, prior: claim.messageSessionID }
    }
    if (claim.delegationID) {
      const errand = yield* errands.get(claim.delegationID).pipe(Effect.orElseSucceed(() => undefined))
      if (
        !errand ||
        errand.recipientID !== claim.agentID ||
        errand.childRunID !== claim.id ||
        (errand.state !== "accepted" && errand.state !== "running") ||
        (errand.sessionID && claim.sessionID && errand.sessionID !== claim.sessionID)
      )
        return undefined
      const matches = claim.sessionID
        ? []
        : yield* input.database.db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(
              sql`
        CASE WHEN json_valid(${SessionTable.metadata}) THEN
          json_extract(${SessionTable.metadata}, '$.rayaRoutine.agentID') = ${claim.agentID}
          AND json_extract(${SessionTable.metadata}, '$.rayaRoutine.runID') = ${claim.id}
          AND json_extract(${SessionTable.metadata}, '$.rayaRoutine.delegationID') = ${claim.delegationID}
        ELSE 0 END
      `,
            )
            .limit(2)
            .all()
            .pipe(Effect.orDie)
      if (!claim.sessionID && matches.length === 0)
        return claim.phase === "claimed" ? { kind: "delegation-empty" as const, errand } : undefined
      if (!claim.sessionID && matches.length !== 1) return undefined
      const sid = claim.sessionID ?? SessionID.make(matches[0].id)
      const session = yield* input.sessions.get(sid).pipe(Effect.orElseSucceed(() => undefined))
      if (!session || session.id !== sid || (errand.sessionID && errand.sessionID !== sid)) return undefined
      const identity = yield* Schema.decodeUnknownEffect(record)(session.metadata?.rayaRoutine).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (
        !identity ||
        identity.trigger.kind === "timer" ||
        identity.agentID !== claim.agentID ||
        identity.runID !== claim.id ||
        identity.delegationID !== claim.delegationID
      )
        return undefined
      if (claim.trigger !== undefined && !isDeepStrictEqual(claim.trigger, identity.trigger)) return undefined
      if (!(yield* tasks.list()).some((item) => item.id === claim.agentID)) return undefined
      const goal = yield* goals.get(sid)
      const history = yield* tasks.runsFor(claim.agentID)
      const prior = history.find((run) => run.id === claim.id)
      const run: RayaTask.Run = {
        id: claim.id,
        agentID: claim.agentID,
        sessionID: sid,
        at: claim.at,
        scheduleVersion: identity.scheduleVersion,
        trigger: identity.trigger,
        status: goal ? "running" : "error",
        ...(goal
          ? {}
          : { blockedReason: "No saved goal is available for this interrupted start. Recovery review is required." }),
      }
      if (
        prior &&
        (prior.sessionID !== run.sessionID ||
          prior.at !== run.at ||
          prior.scheduleVersion !== run.scheduleVersion ||
          !isDeepStrictEqual(prior.trigger, run.trigger))
      )
        return undefined
      return { kind: "delegation" as const, run, errand }
    }
    const candidates = yield* queue.active(claim.agentID).pipe(Effect.orDie)
    if (
      !candidates.some(
        (row) =>
          row.claim_id === claim.id &&
          ((row.state === "starting" && row.session_id === null) ||
            (row.state === "linked" && (!claim.sessionID || row.session_id === claim.sessionID))),
      )
    )
      return undefined
    const matches = claim.sessionID
      ? []
      : yield* input.database.db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(
            sql`
      CASE WHEN json_valid(${SessionTable.metadata}) THEN
        json_extract(${SessionTable.metadata}, '$.rayaRoutine.agentID') = ${claim.agentID}
        AND json_extract(${SessionTable.metadata}, '$.rayaRoutine.runID') = ${claim.id}
      ELSE 0 END
    `,
          )
          .limit(2)
          .all()
          .pipe(Effect.orDie)
    if (!claim.sessionID && matches.length !== 1) return undefined
    const sid = claim.sessionID ?? SessionID.make(matches[0].id)
    const session = yield* input.sessions.get(sid).pipe(Effect.orElseSucceed(() => undefined))
    if (!session || session.id !== sid) return undefined
    const identity = yield* Schema.decodeUnknownEffect(record)(session.metadata?.rayaRoutine).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    if (
      !identity ||
      identity.trigger.kind !== "timer" ||
      identity.agentID !== claim.agentID ||
      identity.runID !== claim.id
    )
      return undefined
    if (claim.trigger !== undefined && !isDeepStrictEqual(claim.trigger, identity.trigger)) return undefined
    const row = yield* queue.get(identity.trigger.id).pipe(Effect.orDie)
    if (
      !row ||
      row.agent_id !== claim.agentID ||
      row.claim_id !== claim.id ||
      row.schedule_version !== identity.scheduleVersion ||
      !((row.state === "starting" && row.session_id === null) || (row.state === "linked" && row.session_id === sid)) ||
      row.scheduled_at !== identity.trigger.scheduledAt ||
      row.observed_at !== identity.trigger.observedAt ||
      (row.timezone ?? undefined) !== identity.trigger.tz
    )
      return undefined
    if (!(yield* tasks.list()).some((item) => item.id === claim.agentID)) return undefined
    const goal = yield* goals.get(sid)
    const history = yield* tasks.runsFor(claim.agentID)
    const prior = history.find((run) => run.id === claim.id)
    const run: RayaTask.Run = {
      id: claim.id,
      agentID: claim.agentID,
      sessionID: sid,
      at: claim.at,
      scheduleVersion: identity.scheduleVersion,
      trigger: identity.trigger,
      status: goal ? "running" : "error",
      ...(goal
        ? {}
        : { blockedReason: "No saved goal is available for this interrupted start. Recovery review is required." }),
    }
    if (
      prior &&
      (prior.sessionID !== run.sessionID ||
        prior.at !== run.at ||
        prior.scheduleVersion !== run.scheduleVersion ||
        !isDeepStrictEqual(prior.trigger, run.trigger))
    )
      return undefined
    return { kind: "timer" as const, run, row }
  })
  return (id: string) =>
    recover(
      input.storage,
      id,
      (claim) => inspect(claim).pipe(Effect.map((run) => run !== undefined)),
      (claim) =>
        Effect.gen(function* () {
          const found = yield* inspect(claim)
          if (!found) return false
          if (found.kind === "delegation-empty") return true
          if (found.kind === "message") {
            const saved = yield* tasks.restore(found.run)
            if (
              saved.id !== found.run.id ||
              saved.sessionID !== found.run.sessionID ||
              saved.at !== found.run.at ||
              saved.scheduleVersion !== found.run.scheduleVersion ||
              !isDeepStrictEqual(saved.trigger, found.run.trigger) ||
              !RayaTask.pending(saved)
            )
              return false
            yield* inbox.move(claim.agentID, found.source, found.prior, found.run.sessionID)
            return (yield* inbox.movable(claim.agentID, found.source, found.prior, found.run.sessionID)) === "target"
          }
          if (found.kind === "delegation") {
            const attached = yield* errands.attach(found.errand.id, found.run.id, found.run.sessionID)
            if (
              attached.childRunID !== found.run.id ||
              attached.sessionID !== found.run.sessionID ||
              attached.state !== "running"
            )
              return false
            const saved = yield* tasks.restore(found.run)
            return (
              saved.id === found.run.id &&
              saved.sessionID === found.run.sessionID &&
              saved.at === found.run.at &&
              saved.scheduleVersion === found.run.scheduleVersion &&
              isDeepStrictEqual(saved.trigger, found.run.trigger)
            )
          }
          if (found.row.state === "starting") {
            yield* queue
              .link({ id: found.row.id, claimID: claim.id, sessionID: found.run.sessionID, now: Date.now() })
              .pipe(Effect.orDie)
          }
          const linked = yield* inspect(claim)
          if (!linked || linked.kind !== "timer" || linked.row.state !== "linked") return false
          const run = linked.run
          const saved = yield* tasks.restore(run)
          return (
            saved.id === run.id &&
            saved.sessionID === run.sessionID &&
            saved.at === run.at &&
            saved.scheduleVersion === run.scheduleVersion &&
            isDeepStrictEqual(saved.trigger, run.trigger)
          )
        }),
    )
}
