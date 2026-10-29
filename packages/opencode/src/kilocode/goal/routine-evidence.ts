import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import {
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineOrganizationTable as Organization,
} from "@opencode-ai/core/kilocode/routine.sql"
import type { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { Codec as Task } from "../task/schema"
import { Codec as Goal } from "./schema"
import { final } from "../task/final-report"
import { Outputs } from "../task/output-scope"
import * as Artifact from "./artifact"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const identity = Schema.Struct({
  version: Schema.Literals([1, 2]),
  agentID: Schema.String,
  runID: Schema.String,
  scheduleVersion: Schema.Number,
  trigger: Task.Trigger,
  delegationID: Schema.optional(Schema.String),
  organizationID: Schema.optional(Schema.String),
  organizationRevision: Schema.optional(Schema.Number),
  outputs: Schema.optional(Schema.Array(Schema.String)),
})
const snapshot = Schema.Struct({
  version: Schema.Literals([1, 2]),
  runID: Schema.String,
  sessionID: SessionID,
  agentID: Schema.String,
  at: Schema.Number,
  definition: Task.Agent,
  objective: Schema.String,
  outputs: Schema.optional(Schema.Array(Schema.String)),
})
type Row = typeof Delegation.$inferSelect
type Part = SessionV1.ToolPart
type Receipt = Part & { state: Extract<Part["state"], { status: "completed" }> }
type Store = Partial<Pick<Storage.Interface, "readBounded">>
type Sessions = Pick<Session.Interface, "messages"> & Partial<Pick<Session.Interface, "get">>
type Report = {
  delegationID: string
  state: string
  workerAuthored: true
  reply?: string
  replyTruncated?: boolean
  artifactsHistorical?: true
  artifacts: unknown
}
const location = (value: string) => {
  const normalized = path.resolve(value)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
const source = (part: Part, sender: string, organization: string) =>
  `delegate:${hash(JSON.stringify([part.sessionID, part.messageID, part.callID, sender, organization])).slice(0, 48)}`
const accepted = (part: SessionV1.Part): part is Receipt =>
  part.type === "tool" &&
  part.tool === "delegate_work" &&
  part.state.status === "completed" &&
  part.state.metadata.requestStatus === "complete"
const unavailable = () =>
  Effect.fail(
    new Error(
      "Routine delegation evidence is unavailable or changed. Refresh get_goal; do not infer completed work or repeat a delegation.",
    ),
  )
const artifacts = Schema.Array(
  Schema.Struct({
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    callID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
).check(Schema.isMaxLength(16))
const parse = (raw: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => new Error("Routine delegation evidence contains invalid JSON."),
  })

/** Admit direct Routine children as evidence only, without changing execution, permissions or output ownership. */
export function observe(input: {
  database?: Database.Interface
  storage: Store
  sessions: Sessions
  goal: typeof Goal.State.Type
  rows: readonly SessionV1.WithParts[]
}) {
  return Effect.gen(function* () {
    const messages: SessionV1.WithParts[] = []
    const reports = new Map<string, Report>()
    const owner = input.goal.routine
    const calls = input.rows
      .filter(
        (row) =>
          row.info.sessionID === owner?.sessionID &&
          row.info.role === "assistant" &&
          input.goal.inputs?.includes(row.info.parentID),
      )
      .flatMap((row) => row.parts.filter(accepted))
    if (!owner || !calls.length) return { messages, reports, check: Effect.void }
    if (
      calls.length > 64 ||
      new Set(calls.map((part) => part.id)).size !== calls.length ||
      new Set(calls.map((part) => part.callID)).size !== calls.length ||
      calls.some((part) => part.sessionID !== owner.sessionID || part.state.time.start < input.goal.createdAt)
    )
      return yield* unavailable()
    if (!input.database || !input.sessions.get || !input.storage.readBounded) return yield* unavailable()
    const database = input.database
    const get = input.sessions.get
    const bounded = input.storage.readBounded.bind(input.storage)
    const checks: Effect.Effect<void, unknown>[] = []
    const read = (key: string[], size: number) =>
      Effect.gen(function* () {
        const value = yield* bounded<unknown>(key, size)
        checks.push(
          bounded<unknown>(key, size).pipe(
            Effect.flatMap((next) => (isDeepStrictEqual(next, value) ? Effect.void : unavailable())),
          ),
        )
        return value
      })
    const session = (id: SessionID) =>
      Effect.gen(function* () {
        const value = yield* get(id)
        const pin = (item: Session.Info) => ({
          id: item.id,
          projectID: item.projectID,
          directory: item.directory,
          parentID: item.parentID,
          permission: item.permission,
          agent: item.agent,
          routine: item.metadata?.rayaRoutine,
        })
        checks.push(
          get(id).pipe(
            Effect.flatMap((next) => (isDeepStrictEqual(pin(next), pin(value)) ? Effect.void : unavailable())),
          ),
        )
        return value
      })
    const rows = (id: SessionID) =>
      Effect.gen(function* () {
        const value = yield* input.sessions.messages({ sessionID: id, limit: 129 })
        const bounded = (rows: readonly SessionV1.WithParts[]) =>
          rows.length <= 128 &&
          rows.every((row) => row.parts.length <= 256) &&
          Buffer.byteLength(JSON.stringify(rows)) <= 2 * 1024 * 1024
        if (!bounded(value)) return yield* unavailable()
        const streaming = new Set(
          id === owner.sessionID
            ? value
                .filter(
                  (row) =>
                    row.info.role === "assistant" &&
                    input.goal.inputs?.includes(row.info.parentID) &&
                    row.parts.some(
                      (part) =>
                        part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"),
                    ),
                )
                .map((row) => row.info.id)
            : [],
        )
        // The parent's current tool runs while its provider finalizes transport fields.
        // Keep all user/security identity and native tool proofs; child final reports stay exact.
        const pin = (rows: readonly SessionV1.WithParts[]) =>
          rows.map((row) => {
            if (row.info.role !== "assistant" || !streaming.has(row.info.id)) return row
            return {
              ...row,
              info: {
                ...row.info,
                cost: undefined,
                tokens: undefined,
                finish: row.info.finish === "tool-calls" ? undefined : row.info.finish,
                time: { ...row.info.time, completed: undefined },
              },
              parts: row.parts.filter(
                (part) => !["text", "reasoning", "step-start", "step-finish"].includes(part.type),
              ),
            }
          })
        const original = pin(value)
        checks.push(
          input.sessions
            .messages({ sessionID: id, limit: 129 })
            .pipe(
              Effect.flatMap((next) =>
                bounded(next) && isDeepStrictEqual(pin(next), original) ? Effect.void : unavailable(),
              ),
            ),
        )
        return value
      })
    const lookup = (id: string) =>
      Effect.gen(function* () {
        const value = yield* database.db.select().from(Delegation).where(eq(Delegation.id, id)).limit(2).all()
        if (value.length !== 1) return yield* unavailable()
        checks.push(
          database.db
            .select()
            .from(Delegation)
            .where(eq(Delegation.id, id))
            .limit(2)
            .all()
            .pipe(Effect.flatMap((next) => (isDeepStrictEqual(next, value) ? Effect.void : unavailable()))),
        )
        return value[0]
      })
    const roster = yield* Schema.decodeUnknownEffect(Schema.Array(Task.Agent))(
      yield* read(["raya", "agent"], 16 * 1024 * 1024),
    )
    const worker = (id: string, runID: string, idSession: SessionID) =>
      Effect.gen(function* () {
        const history = yield* Schema.decodeUnknownEffect(Schema.Union([Schema.Array(Task.Run), Task.History]))(
          yield* read(["raya", "agent-runs", id], 2 * 1024 * 1024),
        )
        const runs = "runs" in history ? history.runs : history
        const run = runs.find((item) => item.id === runID)
        const saved = yield* Schema.decodeUnknownEffect(snapshot)(
          yield* read(["raya", "agent-starts", hash(runID)], 128 * 1024),
        )
        const current = roster.find((item) => item.id === id)
        const target = yield* session(idSession)
        const marker = yield* Schema.decodeUnknownEffect(identity)(target.metadata?.rayaRoutine)
        const goal = yield* Schema.decodeUnknownEffect(Goal.State)(yield* read(["raya", "goal", idSession], 128 * 1024))
        const authority = (item: typeof Task.Agent.Type) => ({
          role: item.role,
          mode: item.mode,
          dir: item.dir,
          access: item.access,
          tools: item.tools,
          paths: item.paths,
          version: item.scheduleVersion,
        })
        const role =
          saved.definition.mode?.trim() ||
          (saved.definition.role === "designer"
            ? "designer"
            : ["coder", "code"].includes(saved.definition.role)
              ? "coder"
              : "generalist")
        if (
          !run ||
          !current ||
          runs.at(-1)?.id !== runID ||
          run.agentID !== id ||
          run.sessionID !== idSession ||
          saved.runID !== runID ||
          saved.sessionID !== idSession ||
          saved.agentID !== id ||
          saved.definition.id !== id ||
          saved.at !== run.at ||
          target.agent !== role ||
          !isDeepStrictEqual(authority(current), authority(saved.definition)) ||
          !saved.definition.dir ||
          location(saved.definition.dir) !== location(target.directory) ||
          marker.agentID !== id ||
          marker.runID !== runID ||
          marker.scheduleVersion !== (run.scheduleVersion ?? 1) ||
          !isDeepStrictEqual(marker.trigger, run.trigger) ||
          !isDeepStrictEqual(marker.outputs, saved.outputs) ||
          goal.createdAt !== run.goalCreatedAt ||
          goal.objective !== saved.objective ||
          !isDeepStrictEqual(goal.routine, { agentID: id, runID, sessionID: idSession }) ||
          !goal.inputs?.length ||
          !goal.intent
        )
          return yield* unavailable()
        return { run, saved, target, marker, goal }
      })
    const parent = yield* worker(owner.agentID, owner.runID, owner.sessionID)
    const captured = yield* rows(owner.sessionID)
    const actual = captured.flatMap((row) => row.parts)
    if (
      parent.goal.inputs?.some(
        (id) =>
          captured.filter(
            (row) => row.info.id === id && row.info.role === "user" && row.info.sessionID === owner.sessionID,
          ).length !== 1,
      )
    )
      return yield* unavailable()
    if (
      calls.some(
        (part) =>
          captured.find((row) => row.info.id === part.messageID)?.info.agent !== parent.target.agent ||
          !isDeepStrictEqual(
            actual.find((item) => item.id === part.id),
            part,
          ),
      )
    )
      return yield* unavailable()
    if (parent.run.status !== "running" || !isDeepStrictEqual(parent.goal, input.goal) || !parent.marker.delegationID)
      return yield* unavailable()
    const incoming = yield* lookup(parent.marker.delegationID)
    if (!incoming.organization_id) return yield* unavailable()
    const organization = yield* database.db
      .select()
      .from(Organization)
      .where(eq(Organization.id, incoming.organization_id))
      .limit(2)
      .all()
    if (organization.length !== 1 || organization[0].archived_at !== null) return yield* unavailable()
    checks.push(
      database.db
        .select()
        .from(Organization)
        .where(eq(Organization.id, incoming.organization_id))
        .limit(2)
        .all()
        .pipe(Effect.flatMap((next) => (isDeepStrictEqual(next, organization) ? Effect.void : unavailable()))),
    )
    const outputs =
      incoming.outputs === null
        ? undefined
        : yield* parse(incoming.outputs).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Outputs)))
    if (
      !["running", "needs_input"].includes(incoming.state) ||
      incoming.recipient_id !== owner.agentID ||
      incoming.child_run_id !== owner.runID ||
      incoming.session_id !== owner.sessionID ||
      incoming.organization_id !== parent.marker.organizationID ||
      incoming.organization_revision !== parent.marker.organizationRevision ||
      incoming.workspace === null ||
      location(incoming.workspace) !== location(parent.target.directory) ||
      !isDeepStrictEqual(outputs, parent.saved.outputs)
    )
      return yield* unavailable()
    const children = yield* database.db
      .select()
      .from(Delegation)
      .where(and(eq(Delegation.parent_run_id, owner.runID), eq(Delegation.sender_id, owner.agentID)))
      .limit(5)
      .all()
    if (children.length > 4 || children.length !== calls.length) return yield* unavailable()
    checks.push(
      database.db
        .select()
        .from(Delegation)
        .where(and(eq(Delegation.parent_run_id, owner.runID), eq(Delegation.sender_id, owner.agentID)))
        .limit(5)
        .all()
        .pipe(Effect.flatMap((next) => (isDeepStrictEqual(next, children) ? Effect.void : unavailable()))),
    )
    const match = (row: Row, part: Receipt, sender: string, runID: string, parentID: string) =>
      row.parent_id === parentID &&
      row.parent_run_id === runID &&
      row.sender_id === sender &&
      row.organization_id === incoming.organization_id &&
      row.organization_revision === incoming.organization_revision &&
      row.workspace !== null &&
      location(row.workspace) === location(parent.target.directory) &&
      row.source === source(part, sender, row.organization_id!) &&
      part.state.metadata?.delegationID === row.id &&
      part.state.metadata?.parentRunID === runID &&
      part.state.metadata?.senderID === sender &&
      part.state.metadata?.recipientID === row.recipient_id &&
      part.state.metadata?.organizationID === row.organization_id &&
      part.state.metadata?.organizationRevision === row.organization_revision
    for (const row of children) {
      const origins = calls.filter((part) => part.state.metadata?.delegationID === row.id)
      if (origins.length !== 1 || !match(row, origins[0], owner.agentID, owner.runID, incoming.id))
        return yield* unavailable()
      const origin = origins[0]
      if (row.state !== "completed") {
        reports.set(origin.id, { delegationID: row.id, state: row.state, workerAuthored: true, artifacts: undefined })
        continue
      }
      if (!row.child_run_id || !row.session_id) return yield* unavailable()
      const child = yield* worker(row.recipient_id, row.child_run_id, SessionID.make(row.session_id))
      const outputs =
        row.outputs === null
          ? undefined
          : yield* parse(row.outputs).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Outputs)))
      if (
        child.run.status !== "complete" ||
        child.goal.status !== "complete" ||
        child.target.projectID !== parent.target.projectID ||
        child.marker.delegationID !== row.id ||
        child.marker.organizationID !== row.organization_id ||
        child.marker.organizationRevision !== row.organization_revision ||
        row.time_created < input.goal.createdAt ||
        child.run.at < row.time_created ||
        !isDeepStrictEqual(child.saved.outputs, outputs)
      )
        return yield* unavailable()
      const captured = yield* rows(child.target.id)
      if (
        child.goal.inputs?.some(
          (id) =>
            captured.filter(
              (item) => item.info.id === id && item.info.role === "user" && item.info.sessionID === child.target.id,
            ).length !== 1,
        )
      )
        return yield* unavailable()
      const result = final(child.run, child.goal, captured)
      if (
        !result ||
        !isDeepStrictEqual(result.report, child.run.outcome?.report) ||
        result.summary !== child.run.outcome?.summary ||
        result.summary !== row.response
      )
        return yield* unavailable()
      reports.set(origin.id, {
        delegationID: row.id,
        state: row.state,
        workerAuthored: true,
        reply: result.summary.slice(0, 4000),
        replyTruncated: result.summary.length > 4000,
        artifacts: undefined,
      })
      const users = new Set(child.goal.inputs)
      const work = captured.filter(
        (item) =>
          item.info.role === "assistant" &&
          users.has(item.info.parentID) &&
          item.info.time.created >= child.goal.createdAt &&
          !item.info.error,
      )
      const allowed = new Set((outputs ?? []).map(location))
      if (
        work.some(
          (item) =>
            item.info.time.created > result.report.at ||
            item.parts.some(
              (part) =>
                part.type === "tool" &&
                part.state.status === "completed" &&
                (!Number.isFinite(part.state.time.start) ||
                  !Number.isFinite(part.state.time.end) ||
                  part.state.time.start < child.goal.createdAt ||
                  part.state.time.end < part.state.time.start ||
                  part.state.time.end > result.report.at),
            ),
        )
      )
        return yield* unavailable()
      for (const item of work) {
        if (
          item.info.sessionID !== child.target.id ||
          (item.parts.some((part) => part.type === "tool") && item.info.agent !== child.target.agent) ||
          item.parts.some((part) => part.sessionID !== child.target.id || part.messageID !== item.info.id)
        )
          return yield* unavailable()
        for (const part of item.parts.filter(accepted)) {
          const id = part.state.metadata?.delegationID
          if (typeof id !== "string") return yield* unavailable()
          const next = yield* lookup(id)
          if (
            !match(next, part, row.recipient_id, row.child_run_id, row.id) ||
            !["queued", "accepted", "running", "needs_input", "completed"].includes(next.state)
          )
            return yield* unavailable()
          const files =
            next.artifacts === null
              ? undefined
              : yield* parse(next.artifacts).pipe(Effect.flatMap(Schema.decodeUnknownEffect(artifacts)))
          const declared = part.state.input.artifacts
          if (
            files?.length &&
            (!Array.isArray(declared) ||
              declared.length !== files.length ||
              files.some(
                (file, index) =>
                  !path.isAbsolute(file.path) ||
                  !allowed.has(location(file.path)) ||
                  typeof declared[index] !== "string" ||
                  location(declared[index]) !== location(file.path) ||
                  !work.some((message) =>
                    message.parts.some(
                      (receipt) =>
                        receipt.type === "tool" &&
                        receipt.state.status === "completed" &&
                        ["write", "edit", "apply_patch"].includes(receipt.tool) &&
                        receipt.tool === file.tool &&
                        receipt.callID === file.callID &&
                        Artifact.entries(receipt.state.metadata.rayaRevision).some(
                          (entry) =>
                            entry.status === "captured" &&
                            location(entry.path) === location(file.path) &&
                            location(entry.canonical) === location(file.path) &&
                            entry.sha256 === file.sha256,
                        ),
                    ),
                  ),
              ))
          )
            return yield* unavailable()
          reports.set(part.id, {
            delegationID: next.id,
            state: next.state,
            workerAuthored: true,
            artifactsHistorical: true,
            artifacts: files,
          })
        }
      }
      for (const item of work) {
        const parts = item.parts.filter((part) => {
          if (accepted(part)) return reports.has(part.id)
          if (
            part.type !== "tool" ||
            part.state.status !== "completed" ||
            !["read", "write", "edit", "apply_patch"].includes(part.tool)
          )
            return false
          const entries = Artifact.entries(part.state.metadata.rayaRevision)
          if (
            !entries.length ||
            entries.some(
              (entry) =>
                !path.isAbsolute(entry.path) ||
                !allowed.has(location(entry.path)) ||
                (entry.status === "captured" &&
                  (!path.isAbsolute(entry.canonical) || !allowed.has(location(entry.canonical)))),
            )
          )
            return false
          if (part.tool === "apply_patch") return true
          const file = part.state.input.filePath
          return typeof file === "string" && path.isAbsolute(file) && allowed.has(location(file))
        })
        if (parts.length) messages.push({ ...item, parts })
      }
    }
    const check = Effect.forEach(checks, (check) => check, { discard: true })
    yield* check
    return { messages, reports, check }
  })
}
