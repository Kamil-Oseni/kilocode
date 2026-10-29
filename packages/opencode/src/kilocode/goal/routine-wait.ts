import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import {
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineMessageTable as Message,
} from "@opencode-ai/core/kilocode/routine.sql"
import type { Database } from "@opencode-ai/core/database/database"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import { SessionID, type MessageID } from "@/session/schema"
import { Codec as Task } from "../task/schema"
import { record as Identity } from "../task/continuation"
import { Codec as Goal } from "./schema"
import * as Evidence from "./routine-evidence"
import { Outputs } from "../task/output-scope"

type State = typeof Goal.State.Type
type Row = typeof Delegation.$inferSelect
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const pin = (row: Row) =>
  hash({ ...row, state: undefined, response: undefined, cost: undefined, reason: undefined, time_updated: undefined })
const refuse = () => new Error("The original child dependency changed. Review the saved worker assignment.")
const location = (value: string) =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
const sessionpin = (session: Session.Info) => ({
  id: session.id,
  projectID: session.projectID,
  directory: session.directory,
  parentID: session.parentID,
  permission: session.permission,
  agent: session.agent,
  routine: session.metadata?.rayaRoutine,
})

/** Only saved own-child receipts can create or release an automatic dependency wait. */
export function observe(input: {
  database?: Database.Interface
  storage: Partial<Pick<Storage.Interface, "readBounded">>
  sessions: Pick<Session.Interface, "messages"> & Partial<Pick<Session.Interface, "get">>
  goal: State
  wake?: boolean
  origin?: { messageID: MessageID; callID: string }
}) {
  return Effect.gen(function* () {
    const goal = input.goal
    const owner = goal.routine
    const prior = goal.dependencyWait
    if (
      !owner ||
      !goal.intent ||
      !goal.inputs?.length ||
      !input.database ||
      !input.sessions.get ||
      !input.storage.readBounded
    )
      return undefined
    const get = input.sessions.get
    const bounded = input.storage.readBounded.bind(input.storage)
    if (
      input.wake &&
      (!prior ||
        prior.runID !== owner.runID ||
        prior.createdAt !== goal.createdAt ||
        prior.intent !== goal.intent ||
        !isDeepStrictEqual(prior.inputs, goal.inputs))
    )
      return undefined
    const rows = yield* input.sessions.messages({ sessionID: owner.sessionID, limit: 129 })
    if (rows.length > 128 || rows.some((row) => row.parts.length > 256)) return yield* Effect.fail(refuse())
    const latest = rows.findLast((row) => row.info.role === "user")
    if (!latest || !goal.inputs.includes(latest.info.id)) return yield* Effect.fail(refuse())
    const origin = input.wake ? prior : input.origin
    if (!origin) return undefined
    const assistant = rows.find((row) => row.info.id === origin.messageID)
    const calls = assistant?.parts.filter(
      (part) => part.type === "tool" && part.tool === "update_goal" && part.callID === origin.callID,
    )
    const call = calls?.length === 1 ? calls[0] : undefined
    if (
      assistant?.info.role !== "assistant" ||
      !goal.inputs.includes(assistant.info.parentID) ||
      assistant.info.sessionID !== owner.sessionID ||
      assistant.info.error ||
      !call ||
      call.type !== "tool" ||
      (input.wake ? call.state.status !== "completed" : call.state.status !== "running") ||
      call.state.input.status !== "blocked" ||
      (input.wake && prior!.input !== hash(call.state.input))
    )
      return yield* Effect.fail(refuse())
    const evidence = yield* Evidence.observe({ ...input, rows })
    const reports = [...evidence.reports.values()]
    const children = yield* input.database.db
      .select()
      .from(Delegation)
      .where(and(eq(Delegation.parent_run_id, owner.runID), eq(Delegation.sender_id, owner.agentID)))
      .limit(5)
      .all()
    if (children.length > 4) return yield* Effect.fail(refuse())
    const selected = input.wake
      ? children.filter((row) => prior!.children.some((item) => item.id === row.id))
      : children.filter((row) => ["accepted", "running", "needs_input"].includes(row.state))
    if (!selected.length) return undefined
    if (input.wake && selected.length !== prior!.children.length) return yield* Effect.fail(refuse())
    const checks: Effect.Effect<void, unknown>[] = [evidence.check]
    const pins: { id: string; sha256: string }[] = []
    const parent = yield* get(owner.sessionID)
    if (
      assistant.info.agent !== parent.agent ||
      call.sessionID !== owner.sessionID ||
      call.messageID !== assistant.info.id ||
      call.state.status === "pending" ||
      call.state.time.start < goal.createdAt ||
      (input.wake && (call.state.status !== "completed" || call.state.time.end < call.state.time.start))
    )
      return yield* Effect.fail(refuse())
    const start = yield* bounded<unknown>(
      ["raya", "agent-starts", createHash("sha256").update(owner.runID).digest("hex")],
      128 * 1024,
    )
    const ownership = hash({ session: sessionpin(parent), snapshot: start })
    if (input.wake && prior!.owner !== ownership) return yield* Effect.fail(refuse())
    for (const row of selected) {
      if (
        !row.child_run_id ||
        !row.session_id ||
        !reports.some((report) => report.delegationID === row.id && report.state === row.state)
      )
        return yield* Effect.fail(refuse())
      if (input.wake) {
        if (!["completed", "failed", "cancelled"].includes(row.state)) return undefined
        if (
          row.state === "completed" &&
          !reports.some((report) => report.delegationID === row.id && typeof report.reply === "string")
        )
          return yield* Effect.fail(refuse())
        const replies = yield* input.database.db
          .select()
          .from(Message)
          .where(and(eq(Message.agent_id, owner.agentID), eq(Message.source, `reply:${row.source}`)))
          .limit(2)
          .all()
        if (
          replies.length !== 1 ||
          replies[0].kind !== "delegation" ||
          replies[0].session_id !== row.session_id ||
          replies[0].occurrence_id !== row.child_run_id ||
          !replies[0].body.trim()
        )
          return yield* Effect.fail(refuse())
        checks.push(
          input.database.db
            .select()
            .from(Message)
            .where(eq(Message.id, replies[0].id))
            .limit(2)
            .all()
            .pipe(Effect.flatMap((next) => (isDeepStrictEqual(next, replies) ? Effect.void : Effect.fail(refuse())))),
        )
      }
      const key = ["raya", "agent-runs", row.recipient_id]
      const raw = yield* bounded<unknown>(key, 2 * 1024 * 1024)
      const history = yield* Schema.decodeUnknownEffect(Schema.Union([Schema.Array(Task.Run), Task.History]))(raw)
      const runs = "runs" in history ? history.runs : history
      const run = runs.at(-1)
      const session = yield* get(SessionID.make(row.session_id))
      const identity = yield* Schema.decodeUnknownEffect(Identity)(session.metadata?.rayaRoutine)
      const startkey = ["raya", "agent-starts", createHash("sha256").update(row.child_run_id).digest("hex")]
      const saved = yield* bounded<unknown>(startkey, 128 * 1024)
      const snapshot = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          runID: Schema.String,
          sessionID: SessionID,
          agentID: Schema.String,
          at: Schema.Number,
          definition: Task.Agent,
          objective: Schema.String,
          outputs: Schema.optional(Schema.Array(Schema.String)),
        }),
      )(saved)
      const childkey = ["raya", "goal", row.session_id]
      const rawgoal =
        !input.wake || row.state === "completed" ? yield* bounded<unknown>(childkey, 128 * 1024) : undefined
      const child = rawgoal === undefined ? undefined : yield* Schema.decodeUnknownEffect(Goal.State)(rawgoal)
      const outputs =
        row.outputs === null
          ? undefined
          : yield* Effect.try({ try: () => JSON.parse(row.outputs!) as unknown, catch: refuse }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Outputs)),
            )
      const role =
        snapshot.definition.mode?.trim() ||
        (snapshot.definition.role === "designer"
          ? "designer"
          : ["coder", "code"].includes(snapshot.definition.role)
            ? "coder"
            : "generalist")
      if (
        !run ||
        run.id !== row.child_run_id ||
        run.sessionID !== row.session_id ||
        run.agentID !== row.recipient_id ||
        (input.wake
          ? row.state === "completed"
            ? run.status !== "complete"
            : row.state === "cancelled"
              ? run.status !== "stopped"
              : !["blocked", "error"].includes(run.status)
          : run.status !== "running") ||
        identity.agentID !== row.recipient_id ||
        identity.runID !== run.id ||
        identity.delegationID !== row.id ||
        identity.organizationID !== row.organization_id ||
        identity.organizationRevision !== row.organization_revision ||
        identity.scheduleVersion !== (run.scheduleVersion ?? 1) ||
        !isDeepStrictEqual(identity.trigger, run.trigger) ||
        snapshot.runID !== run.id ||
        snapshot.agentID !== run.agentID ||
        snapshot.sessionID !== session.id ||
        snapshot.at !== run.at ||
        snapshot.definition.id !== run.agentID ||
        session.agent !== role ||
        (child &&
          (child.createdAt !== run.goalCreatedAt ||
            child.objective !== snapshot.objective ||
            !isDeepStrictEqual(child.routine, { agentID: run.agentID, runID: run.id, sessionID: run.sessionID }))) ||
        !snapshot.definition.dir ||
        location(snapshot.definition.dir) !== location(session.directory) ||
        session.projectID !== parent.projectID ||
        session.directory !== parent.directory ||
        !isDeepStrictEqual(identity.outputs, snapshot.outputs) ||
        !isDeepStrictEqual(outputs, snapshot.outputs)
      )
        return yield* Effect.fail(refuse())
      if (
        input.wake &&
        row.state === "failed" &&
        (!row.reason ||
          row.reason !== run.blockedReason ||
          (row.response !== null && row.response !== run.outcome?.summary))
      )
        return yield* Effect.fail(refuse())
      if (input.wake && row.state === "cancelled" && !run.stop) return yield* Effect.fail(refuse())
      const sha256 = hash({
        row: pin(row),
        snapshot: saved,
        session: sessionpin(session),
        run: {
          id: run.id,
          at: run.at,
          agentID: run.agentID,
          sessionID: run.sessionID,
          goalCreatedAt: run.goalCreatedAt,
          trigger: run.trigger,
          scheduleVersion: run.scheduleVersion,
        },
      })
      if (input.wake && prior!.children.find((item) => item.id === row.id)?.sha256 !== sha256)
        return yield* Effect.fail(refuse())
      pins.push({ id: row.id, sha256 })
      checks.push(
        bounded<unknown>(key, 2 * 1024 * 1024).pipe(
          Effect.flatMap((next) => (isDeepStrictEqual(next, raw) ? Effect.void : Effect.fail(refuse()))),
        ),
      )
      checks.push(
        get(session.id).pipe(
          Effect.flatMap((next) =>
            isDeepStrictEqual(sessionpin(next), sessionpin(session)) ? Effect.void : Effect.fail(refuse()),
          ),
        ),
      )
      for (const [key, size, raw] of [
        [startkey, 128 * 1024, saved],
        [childkey, 128 * 1024, rawgoal],
      ] as const)
        if (raw !== undefined)
          checks.push(
            bounded<unknown>([...key], size).pipe(
              Effect.flatMap((next) => (isDeepStrictEqual(next, raw) ? Effect.void : Effect.fail(refuse()))),
            ),
          )
    }
    const check = Effect.forEach(checks, (check) => check, { discard: true })
    yield* check
    return {
      marker: {
        runID: owner.runID,
        createdAt: goal.createdAt,
        intent: goal.intent,
        owner: ownership,
        messageID: origin.messageID,
        callID: origin.callID,
        input: hash(call.state.input),
        inputs: goal.inputs,
        children: pins,
      },
      check,
    }
  })
}

/** End the current model loop before another compaction can replace a waiting input. */
export function parked(storage: Pick<Storage.Interface, "readBounded">, sessionID: SessionID, userID: MessageID) {
  return storage.readBounded<unknown>(["raya", "goal", sessionID], 128 * 1024).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Goal.State)),
    Effect.map(
      (goal) =>
        goal.status === "paused" &&
        goal.pause === "agent" &&
        goal.routine?.sessionID === sessionID &&
        goal.dependencyWait?.runID === goal.routine.runID &&
        goal.dependencyWait.createdAt === goal.createdAt &&
        goal.dependencyWait.intent === goal.intent &&
        isDeepStrictEqual(goal.dependencyWait.inputs, goal.inputs) &&
        goal.dependencyWait.inputs.includes(userID),
    ),
    Effect.catchTag("NotFoundError", () => Effect.succeed(false)),
    Effect.orDie,
  )
}
