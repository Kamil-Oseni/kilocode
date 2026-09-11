import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineDelegationTable as Delegation } from "@opencode-ai/core/kilocode/routine.sql"
import { SessionID } from "@/session/schema"
import { RayaTask } from "./index"
import { RayaTaskInbox, type Publish } from "./inbox"

const token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.:-]{1,128}$/))
const body = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(8000))
const State = Schema.Literals(["queued", "accepted", "running", "needs_input", "completed", "failed", "cancelled"])
const live = ["queued", "accepted", "running", "needs_input"] as const
const DEPTH = 3
const FAN = 4

export const Request = Schema.Struct({
  source: token,
  senderID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  recipientID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  parentID: Schema.optional(token),
  parentRunID: Schema.optional(token),
  objective: body,
  expected: Schema.optional(body),
  context: Schema.optional(body),
  deadline: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8.64e15))),
  budget: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000))),
})

export const Record = Schema.Struct({
  id: token,
  source: token,
  senderID: Request.fields.senderID,
  recipientID: Request.fields.recipientID,
  parentID: Schema.optional(token),
  parentRunID: Schema.optional(token),
  workspace: Schema.optional(Schema.String),
  objective: body,
  expected: Schema.optional(body),
  context: Schema.optional(body),
  deadline: Request.fields.deadline,
  budget: Request.fields.budget,
  depth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: DEPTH })),
  state: State,
  childRunID: Schema.optional(token),
  sessionID: Schema.optional(SessionID),
  response: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
  time: Schema.Number,
})

export type Request = typeof Request.Type
export type Record = typeof Record.Type

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("RayaTaskDelegation.Conflict", {
  message: Schema.String,
}) {}
export class Invalid extends Schema.TaggedErrorClass<Invalid>()("RayaTaskDelegation.Invalid", {
  message: Schema.String,
}) {}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function key(source: string) {
  return `rdl_${digest(source).slice(0, 48)}`
}

function origin(kind: "ask" | "sent" | "reply", source: string) {
  const raw = `${kind}:${source}`
  return Schema.is(token)(raw) ? raw : `${kind}:${digest(source).slice(0, 40)}`
}

function folder(value?: string) {
  const path = value?.trim()
  if (!path) return
  return path.replaceAll("\\", "/").replace(/\/+$/, "")
}

export function scope(sender: Pick<RayaTask.Agent, "dir">, recipient: Pick<RayaTask.Agent, "dir">) {
  const from = folder(sender.dir)
  const to = folder(recipient.dir)
  if (from && to && from !== to) return
  return to ?? from
}

export function ceiling(
  sender: Pick<RayaTask.Agent, "role" | "access">,
  recipient: Pick<RayaTask.Agent, "role" | "access" | "tools">,
) {
  if (RayaTask.brief(sender) || RayaTask.brief(recipient)) return { ...recipient, access: "brief" as const }
  return recipient
}

export function prompt(sender: RayaTask.Agent, recipient: RayaTask.Agent, request: Request) {
  return [
    "Answer this request from another worker. The standing assignment and schedule are unchanged. Do not rewrite them, and do not treat this as a request to run the recurring job now.",
    `Requesting worker: ${sender.name} (${sender.role})`,
    `Request objective:\n${request.objective}`,
    request.expected ? `Expected result:\n${request.expected}` : undefined,
    request.context ? `Permitted context:\n${request.context}` : undefined,
    `Your standing assignment:\n${recipient.objective}`,
    "Do not invent a worker reply that has not arrived. Attribute findings to this request.",
  ]
    .filter((line): line is string => !!line)
    .join("\n\n")
}

function decode(row: typeof Delegation.$inferSelect): Record {
  return {
    id: row.id,
    source: row.source,
    senderID: row.sender_id,
    recipientID: row.recipient_id,
    objective: row.objective,
    depth: row.depth,
    state: row.state as Record["state"],
    time: row.time_created,
    ...(row.parent_id ? { parentID: row.parent_id } : {}),
    ...(row.parent_run_id ? { parentRunID: row.parent_run_id } : {}),
    ...(row.workspace ? { workspace: row.workspace } : {}),
    ...(row.expected ? { expected: row.expected } : {}),
    ...(row.context ? { context: row.context } : {}),
    ...(row.deadline !== null ? { deadline: row.deadline } : {}),
    ...(row.budget !== null ? { budget: row.budget } : {}),
    ...(row.child_run_id ? { childRunID: row.child_run_id } : {}),
    ...(row.session_id ? { sessionID: SessionID.make(row.session_id) } : {}),
    ...(row.response ? { response: row.response } : {}),
    ...(row.cost !== null ? { cost: row.cost } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  }
}

function same(saved: Record, value: Request) {
  return (
    saved.senderID === value.senderID &&
    saved.recipientID === value.recipientID &&
    saved.objective === value.objective &&
    saved.expected === value.expected &&
    saved.context === value.context &&
    saved.parentID === value.parentID &&
    saved.parentRunID === value.parentRunID &&
    saved.deadline === value.deadline &&
    saved.budget === value.budget
  )
}

function cards(row: Record, sender: RayaTask.Agent, recipient: RayaTask.Agent): Publish[] {
  const ask = `Request from ${sender.name}:\n${row.objective}`
  const sent = `Asked ${recipient.name}:\n${row.objective}`
  return [
    { agentID: recipient.id, source: origin("ask", row.source), kind: "delegation", body: ask.slice(0, 8000) },
    { agentID: sender.id, source: origin("sent", row.source), kind: "delegation", body: sent.slice(0, 8000) },
  ]
}

export function replied(row: Record, recipient: RayaTask.Agent): Publish | undefined {
  if (row.state === "queued" || row.state === "accepted" || row.state === "running") return
  const findings = row.response?.trim()
  const lines =
    row.state === "completed"
      ? [`Reply from ${recipient.name}.`, findings || "No written reply was saved. This is not invented success."]
      : [
          `Delegation ${row.state} (${recipient.name}).`,
          row.reason || findings || "No written reply was saved.",
          "This is not a completed worker reply.",
        ]
  const body = lines.join("\n").slice(0, 8000)
  if (!body.trim()) return
  return {
    agentID: row.senderID,
    source: origin("reply", row.source),
    kind: "delegation",
    body,
    sessionID: row.sessionID,
    ...(row.childRunID && Schema.is(token)(row.childRunID) ? { occurrenceID: row.childRunID } : {}),
  }
}

export namespace RayaTaskDelegation {
  export function make(database: Database.Interface) {
    const db = database.db
    const inbox = RayaTaskInbox.make(database)
    const publish = (items: readonly Publish[]) =>
      Effect.forEach(items, (item) =>
        inbox.publish(item).pipe(
          Effect.catch((error) =>
            typeof error === "object" && error !== null && "_tag" in error && error._tag === "RayaTaskInbox.Conflict"
              ? Effect.void
              : Effect.die(error),
          ),
        ),
      )
    const get = Effect.fn("RayaTaskDelegation.get")(function* (id: string) {
      const row = yield* db.select().from(Delegation).where(eq(Delegation.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* new Invalid({ message: "This delegation request was not found." })
      return decode(row)
    })
    const lookup = Effect.fn("RayaTaskDelegation.lookup")(function* (source: string) {
      const row = yield* db.select().from(Delegation).where(eq(Delegation.source, source)).get().pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })
    const ancestors = Effect.fn("RayaTaskDelegation.ancestors")(function* (id?: string) {
      const seen: Record[] = []
      let current = id
      while (current) {
        if (seen.length >= DEPTH) return yield* new Invalid({ message: "This delegation chain is too deep." })
        const row = yield* db.select().from(Delegation).where(eq(Delegation.id, current)).get().pipe(Effect.orDie)
        if (!row) return yield* new Invalid({ message: "The parent delegation request was not found." })
        const item = decode(row)
        seen.push(item)
        current = item.parentID
      }
      return seen
    })
    const outstanding = Effect.fn("RayaTaskDelegation.outstanding")(function* (senderID: string, parentID?: string) {
      const rows = yield* (parentID
        ? db
            .select()
            .from(Delegation)
            .where(and(eq(Delegation.parent_id, parentID), inArray(Delegation.state, [...live])))
        : db
            .select()
            .from(Delegation)
            .where(and(eq(Delegation.sender_id, senderID), isNull(Delegation.parent_id), inArray(Delegation.state, [...live])))
      )
        .all()
        .pipe(Effect.orDie)
      return rows.length
    })
    const admit = Effect.fn("RayaTaskDelegation.admit")(function* (input: Request, sender: RayaTask.Agent, recipient: RayaTask.Agent) {
      const value = yield* Schema.decodeUnknownEffect(Request)(input).pipe(
        Effect.mapError(() => new Invalid({ message: "Delegation requests need a stable source and a non-empty objective." })),
      )
      if (value.senderID !== sender.id || value.recipientID !== recipient.id)
        return yield* new Invalid({ message: "Delegation identities must match the requesting and receiving workers." })
      if (value.senderID === value.recipientID)
        return yield* new Invalid({ message: "A worker cannot delegate to itself." })
      const workspace = scope(sender, recipient)
      if (sender.dir?.trim() && recipient.dir?.trim() && workspace === undefined)
        return yield* new Invalid({ message: "This request cannot leave the sender's workspace." })
      if (value.deadline !== undefined && value.deadline <= Date.now())
        return yield* new Invalid({ message: "This delegation deadline has already passed." })
      const prior = yield* lookup(value.source)
      if (prior) {
        if (!same(prior, value)) return yield* new Conflict({ message: "This delegation source already has a different request." })
        return { record: prior, created: false }
      }
      const lineage = yield* ancestors(value.parentID)
      const depth = lineage.length + 1
      if (depth > DEPTH) return yield* new Invalid({ message: "This delegation chain is too deep." })
      const ids = new Set(lineage.flatMap((item) => [item.senderID, item.recipientID]))
      ids.add(value.senderID)
      if (ids.has(value.recipientID)) return yield* new Invalid({ message: "This delegation would create a cycle." })
      if (value.parentID && lineage[0] && lineage[0].id !== value.parentID)
        return yield* new Invalid({ message: "The parent delegation request was not found." })
      const count = yield* outstanding(value.senderID, value.parentID)
      if (count >= FAN)
        return yield* new Invalid({ message: "This worker already has too many outstanding delegated requests." })
      if (!recipient.enabled)
        return yield* persist(value, sender, recipient, workspace, depth, "failed", "This worker is paused. Delegation is not started until it is enabled.")
      if (recipient.access === undefined)
        return yield* persist(
          value,
          sender,
          recipient,
          workspace,
          depth,
          "failed",
          "Review this older routine's workspace access before starting delegated work.",
        )
      return yield* persist(value, sender, recipient, workspace, depth, "queued")
    })
    const persist = Effect.fn("RayaTaskDelegation.persist")(function* (
      value: Request,
      sender: RayaTask.Agent,
      recipient: RayaTask.Agent,
      workspace: string | undefined,
      depth: number,
      state: Record["state"],
      reason?: string,
    ) {
      const now = Date.now()
      const row = {
        id: key(value.source),
        source: value.source,
        sender_id: value.senderID,
        recipient_id: value.recipientID,
        parent_id: value.parentID ?? null,
        parent_run_id: value.parentRunID ?? null,
        workspace: workspace ?? null,
        objective: value.objective,
        expected: value.expected ?? null,
        context: value.context ?? null,
        deadline: value.deadline ?? null,
        budget: value.budget ?? null,
        depth,
        state,
        child_run_id: null,
        session_id: null,
        response: null,
        cost: null,
        reason: reason ?? null,
        time_created: now,
        time_updated: now,
      }
      yield* db.insert(Delegation).values(row).run().pipe(Effect.orDie)
      const record = decode(row)
      yield* publish(cards(record, sender, recipient))
      return { record, created: true }
    })
    const take = Effect.fn("RayaTaskDelegation.take")(function* (recipientID: string) {
      const row = yield* db
        .select()
        .from(Delegation)
        .where(and(eq(Delegation.recipient_id, recipientID), eq(Delegation.state, "queued")))
        .orderBy(asc(Delegation.time_created), asc(Delegation.id))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      const now = Date.now()
      const updated = yield* db
        .update(Delegation)
        .set({ state: "accepted", time_updated: now })
        .where(and(eq(Delegation.id, row.id), eq(Delegation.state, "queued")))
        .returning()
        .all()
        .pipe(Effect.orDie)
      return updated[0] ? decode(updated[0]) : undefined
    })
    const attach = Effect.fn("RayaTaskDelegation.attach")(function* (id: string, runID: string, sessionID: SessionID) {
      const prior = yield* get(id)
      if (prior.childRunID && prior.childRunID !== runID)
        return yield* new Conflict({ message: "This delegation is already attached to another run." })
      if (prior.sessionID && prior.sessionID !== sessionID)
        return yield* new Conflict({ message: "This delegation is already attached to another session." })
      if (prior.childRunID === runID && prior.sessionID === sessionID) return prior
      if (prior.state !== "accepted" && prior.state !== "running")
        return yield* new Conflict({ message: "This delegation cannot start from its current state." })
      const now = Date.now()
      yield* db
        .update(Delegation)
        .set({ state: "running", child_run_id: runID, session_id: sessionID, time_updated: now })
        .where(eq(Delegation.id, id))
        .run()
        .pipe(Effect.orDie)
      return decode({
        ...(yield* db.select().from(Delegation).where(eq(Delegation.id, id)).get().pipe(Effect.orDie))!,
      })
    })
    const finish = Effect.fn("RayaTaskDelegation.finish")(function* (
      id: string,
      state: "completed" | "failed" | "needs_input" | "cancelled",
      recipient: RayaTask.Agent,
      response?: string,
      cost?: number,
      reason?: string,
    ) {
      const prior = yield* get(id)
      if (prior.state === "completed" || prior.state === "failed" || prior.state === "cancelled") {
        if (prior.state === state && prior.response === response && prior.cost === cost && prior.reason === reason)
          return prior
        return yield* new Conflict({ message: "This delegation already has a different result." })
      }
      const now = Date.now()
      yield* db
        .update(Delegation)
        .set({
          state,
          response: response ?? null,
          cost: cost ?? null,
          reason: reason ?? null,
          time_updated: now,
        })
        .where(eq(Delegation.id, id))
        .run()
        .pipe(Effect.orDie)
      const record = yield* get(id)
      const item = replied(record, recipient)
      if (item) yield* publish([item])
      return record
    })
    const chain = Effect.fn("RayaTaskDelegation.chain")(function* (id: string) {
      const current = yield* get(id)
      const above = yield* ancestors(current.parentID)
      return [...above.reverse(), current]
    })
    const queued = Effect.fn("RayaTaskDelegation.queued")(function* (recipientID: string) {
      const rows = yield* db
        .select()
        .from(Delegation)
        .where(and(eq(Delegation.recipient_id, recipientID), eq(Delegation.state, "queued")))
        .orderBy(asc(Delegation.time_created), asc(Delegation.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })
    const bySession = Effect.fn("RayaTaskDelegation.bySession")(function* (sessionID: SessionID) {
      const row = yield* db.select().from(Delegation).where(eq(Delegation.session_id, sessionID)).get().pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })
    return { admit, take, attach, finish, get, lookup, chain, queued, bySession }
  }
}
