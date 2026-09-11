import { and, count, desc, eq, gt, lt, ne, or } from "drizzle-orm"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineConversationTable as Conversation,
  RayaRoutineMessageTable as Message,
} from "@opencode-ai/core/kilocode/routine.sql"
import { SessionID } from "@/session/schema"
import { RayaTask } from "./index"

const token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.:-]{1,128}$/))
const body = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(8000))
const Kind = Schema.Literals(["user", "worker", "report", "decision", "delegation"])
export const State = Schema.Literals(["scheduled", "running", "waiting", "needs_input", "paused", "failed"])
export const Record = Schema.Struct({
  id: token,
  agentID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  kind: Kind,
  source: token,
  body,
  occurrenceID: Schema.optional(token),
  sessionID: Schema.optional(SessionID),
  time: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8.64e15)),
})
export const Publish = Schema.Struct({
  agentID: Record.fields.agentID,
  source: token,
  kind: Kind,
  body,
  occurrenceID: Schema.optional(token),
  sessionID: Schema.optional(SessionID),
})
export const Send = Schema.Struct({ source: token, body })
export const Read = Schema.Struct({
  at: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8.64e15)),
})
export const Draft = Schema.Struct({ draft: Schema.Union([Schema.String.check(Schema.isMaxLength(8000)), Schema.Null]) })
export const Page = Schema.Struct({
  messages: Schema.Array(Record),
  next: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
})
export const Item = Schema.Struct({
  agentID: Record.fields.agentID,
  conversationID: token,
  name: Schema.String,
  role: Schema.String,
  latest: Schema.optional(Record),
  unread: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: State,
  nextRun: Schema.optional(Schema.Number),
  draft: Schema.optional(Schema.String),
})
export type Record = typeof Record.Type
export type Publish = typeof Publish.Type
export type Item = typeof Item.Type
export type Page = typeof Page.Type

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("RayaTaskInbox.Conflict", {
  message: Schema.String,
}) {}
export class Invalid extends Schema.TaggedErrorClass<Invalid>()("RayaTaskInbox.Invalid", {
  message: Schema.String,
}) {}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function marker(cursor?: string) {
  if (cursor === undefined) return { ok: true as const }
  const at = cursor.indexOf(":")
  if (at <= 0) return { ok: false as const }
  const time = Number(cursor.slice(0, at))
  const id = cursor.slice(at + 1)
  if (!Number.isSafeInteger(time) || time < 0 || !id) return { ok: false as const }
  return { ok: true as const, time, id }
}

function key(agentID: string) {
  return `rcv_${digest(agentID).slice(0, 48)}`
}

function receipt(agentID: string, source: string) {
  return `rmg_${digest(JSON.stringify([agentID, source])).slice(0, 48)}`
}

function decode(row: typeof Message.$inferSelect): Record {
  return {
    id: row.id,
    agentID: row.agent_id,
    kind: row.kind,
    source: row.source,
    body: row.body,
    time: row.time_created,
    ...(row.occurrence_id ? { occurrenceID: row.occurrence_id } : {}),
    ...(row.session_id ? { sessionID: SessionID.make(row.session_id) } : {}),
  }
}

export function status(agent: RayaTask.Agent, last?: RayaTask.Run): typeof State.Type {
  if (agent.execution?.state === "starting" || agent.execution?.state === "active") return "running"
  if (agent.execution?.state === "recovery") return "failed"
  if (!agent.enabled) return "paused"
  if (last?.status === "blocked" && last.blockedReason === "waiting on you") return "needs_input"
  if (last?.status === "blocked") return "waiting"
  if (last?.status === "error") return "failed"
  return "scheduled"
}

export namespace RayaTaskInbox {
  export function make(database: Database.Interface) {
    const db = database.db
    const ensure = Effect.fn("RayaTaskInbox.ensure")(function* (agentID: string) {
      const now = Date.now()
      const id = key(agentID)
      yield* db
        .insert(Conversation)
        .values({ agent_id: agentID, id, read_at: 0, time_updated: now })
        .onConflictDoNothing()
        .run()
      const row = yield* db.select().from(Conversation).where(eq(Conversation.agent_id, agentID)).get()
      if (!row) return yield* Effect.die(new Error("Routine conversation could not be created."))
      return row
    })
    const publish = Effect.fn("RayaTaskInbox.publish")(function* (input: Publish) {
      const value = yield* Schema.decodeUnknownEffect(Publish)(input).pipe(
        Effect.mapError(() => new Invalid({ message: "Routine inbox messages need a stable source and non-empty body." })),
      )
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(Conversation)
              .values({ agent_id: value.agentID, id: key(value.agentID), read_at: 0, time_updated: Date.now() })
              .onConflictDoNothing()
              .run()
            const prior = yield* tx
              .select()
              .from(Message)
              .where(and(eq(Message.agent_id, value.agentID), eq(Message.source, value.source)))
              .get()
            if (prior) {
              const saved = decode(prior)
              if (
                saved.kind !== value.kind ||
                saved.body !== value.body ||
                saved.occurrenceID !== value.occurrenceID ||
                saved.sessionID !== value.sessionID
              )
                return yield* new Conflict({ message: "This inbox source already has a different message." })
              return saved
            }
            const now = Date.now()
            const row = {
              id: receipt(value.agentID, value.source),
              agent_id: value.agentID,
              source: value.source,
              kind: value.kind,
              body: value.body,
              occurrence_id: value.occurrenceID ?? null,
              session_id: value.sessionID ?? null,
              time_created: now,
            }
            yield* tx.insert(Message).values(row).run()
            yield* tx
              .update(Conversation)
              .set({ time_updated: now })
              .where(eq(Conversation.agent_id, value.agentID))
              .run()
            return decode(row)
          }),
        { behavior: "immediate" },
      )
    })
    const page = Effect.fn("RayaTaskInbox.page")(function* (agentID: string, cursor?: string, limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        return yield* new Invalid({ message: "Inbox pages are limited to 50 messages." })
      yield* ensure(agentID)
      const parsed = marker(cursor)
      if (!parsed.ok) return yield* new Invalid({ message: "This inbox page cursor is invalid." })
      const bound =
        "id" in parsed
          ? or(lt(Message.time_created, parsed.time), and(eq(Message.time_created, parsed.time), lt(Message.id, parsed.id)))
          : undefined
      const rows = yield* db
        .select()
        .from(Message)
        .where(and(eq(Message.agent_id, agentID), bound))
        .orderBy(desc(Message.time_created), desc(Message.id))
        .limit(limit + 1)
        .all()
      const extra = rows.length > limit
      const slice = rows.slice(0, limit).reverse()
      return {
        messages: slice.map(decode),
        ...(extra && slice[0] ? { next: `${slice[0].time}:${slice[0].id}` } : {}),
      }
    })
    const read = Effect.fn("RayaTaskInbox.read")(function* (agentID: string, at: number) {
      yield* Schema.decodeUnknownEffect(Read)({ at }).pipe(
        Effect.mapError(() => new Invalid({ message: "Inbox read position must be a finite timestamp." })),
      )
      const row = yield* ensure(agentID)
      if (at < row.read_at) return row.read_at
      yield* db
        .update(Conversation)
        .set({ read_at: at, time_updated: Date.now() })
        .where(eq(Conversation.agent_id, agentID))
        .run()
      return at
    })
    const draft = Effect.fn("RayaTaskInbox.draft")(function* (agentID: string, text: string | null) {
      yield* Schema.decodeUnknownEffect(Draft)({ draft: text }).pipe(
        Effect.mapError(() => new Invalid({ message: "Inbox drafts are limited to 8000 characters." })),
      )
      yield* ensure(agentID)
      const saved = text && text.length ? text : null
      yield* db
        .update(Conversation)
        .set({ draft: saved, time_updated: Date.now() })
        .where(eq(Conversation.agent_id, agentID))
        .run()
      return saved
    })
    const unread = Effect.fn("RayaTaskInbox.unread")(function* (agentID: string, at: number) {
      const row = yield* db
        .select({ n: count() })
        .from(Message)
        .where(and(eq(Message.agent_id, agentID), ne(Message.kind, "user"), gt(Message.time_created, at)))
        .get()
      return row?.n ?? 0
    })
    const latest = Effect.fn("RayaTaskInbox.latest")(function* (agentID: string) {
      const row = yield* db
        .select()
        .from(Message)
        .where(eq(Message.agent_id, agentID))
        .orderBy(desc(Message.time_created), desc(Message.id))
        .limit(1)
        .get()
      return row ? decode(row) : undefined
    })
    const summaries = Effect.fn("RayaTaskInbox.summaries")(function* (
      agents: readonly RayaTask.Agent[],
      runs: ReadonlyMap<string, RayaTask.Run | undefined>,
    ) {
      const items: Item[] = []
      for (const agent of agents) {
        const row = yield* ensure(agent.id)
        const last = yield* latest(agent.id)
        items.push({
          agentID: agent.id,
          conversationID: row.id,
          name: agent.name,
          role: agent.role,
          unread: yield* unread(agent.id, row.read_at),
          state: status(agent, runs.get(agent.id)),
          ...(row.draft ? { draft: row.draft } : {}),
          ...(agent.nextRun !== undefined ? { nextRun: agent.nextRun } : {}),
          ...(last ? { latest: last } : {}),
        })
      }
      return items
    })
    return { ensure, publish, page, read, draft, summaries }
  }
}
