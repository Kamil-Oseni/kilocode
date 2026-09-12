import { and, desc, eq, lt, or, sql } from "drizzle-orm"
import { Effect, Exit, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineMessageTable as Message,
} from "@opencode-ai/core/kilocode/routine.sql"
import { SessionID } from "@/session/schema"
import { Clip, Record as MessageRecord } from "./inbox"

const token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.:-]{1,128}$/))
const stamp = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8.64e15))
const Files = Schema.Array(Clip).check(Schema.isMaxLength(8))
const decoded = Schema.decodeUnknownExit(Files)
const CAP = 500

export const Section = Schema.Literals(["shares", "contacts"])
export const Query = Schema.Struct({
  section: Section,
  cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50))),
})
const ShareBase = {
  messageID: token,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  time: stamp,
  messageKind: MessageRecord.fields.kind,
  source: token,
  occurrenceID: Schema.optional(token),
  sessionID: Schema.optional(SessionID),
}
export const Share = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("file"),
    ...ShareBase,
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  }),
  Schema.Struct({
    kind: Schema.Literal("link"),
    ...ShareBase,
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
  }),
])
export const Contact = Schema.Struct({
  peerID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  name: Schema.String.check(Schema.isMinLength(1)),
  role: Schema.String.check(Schema.isMinLength(1)),
  archived: Schema.Boolean,
  direction: Schema.Literals(["sent", "received"]),
  delegationID: token,
  source: token,
  state: Schema.Literals(["queued", "accepted", "running", "needs_input", "completed", "failed", "cancelled"]),
  objective: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(8000)),
  expected: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  parentID: Schema.optional(token),
  parentRunID: Schema.optional(token),
  deadline: Schema.optional(stamp),
  budget: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000))),
  time: stamp,
  updated: stamp,
  response: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  occurrenceID: Schema.optional(token),
  sessionID: Schema.optional(SessionID),
})
export const SharePage = Schema.Struct({
  section: Schema.Literal("shares"),
  items: Schema.Array(Share),
  next: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
})
export const ContactPage = Schema.Struct({
  section: Schema.Literal("contacts"),
  items: Schema.Array(Contact),
  next: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
})
export const Page = Schema.Union([SharePage, ContactPage])
export type Query = typeof Query.Type
export type Share = typeof Share.Type
export type Contact = typeof Contact.Type
export type Page = typeof Page.Type
export type Identity = Pick<Contact, "name" | "role" | "archived">

const ShareCursor = Schema.Struct({
  section: Schema.Literal("shares"),
  time: stamp,
  id: token,
  skip: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000)),
})
const ContactCursor = Schema.Struct({ section: Schema.Literal("contacts"), time: stamp, id: token })

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("RayaTaskInfo.Invalid", {
  message: Schema.String,
}) {}

function encode(value: typeof ShareCursor.Type | typeof ContactCursor.Type) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function cursor(value?: string) {
  if (value === undefined) return Effect.succeed(undefined)
  return Effect.try({
    try: () => JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    catch: () => new Invalid({ message: "This routine info cursor is invalid." }),
  })
}

function files(raw: string | null) {
  if (!raw || raw[0] !== "[") return []
  const result = decoded(JSON.parse(raw))
  return Exit.isSuccess(result) ? result.value : []
}

function links(body: string) {
  const result: { label: string; url: string }[] = []
  for (const match of body.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const url = match[0].replace(/[),.;:!?}\]]+$/, "")
    if (!url) continue
    if (!URL.canParse(url)) continue
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue
    result.push({ label: parsed.hostname || url, url })
  }
  return result
}

function shares(row: typeof Message.$inferSelect): Share[] {
  const meta = {
    messageID: row.id,
    time: row.time_created,
    messageKind: row.kind,
    source: row.source,
    ...(row.occurrence_id ? { occurrenceID: row.occurrence_id } : {}),
    ...(row.session_id ? { sessionID: SessionID.make(row.session_id) } : {}),
  }
  return [
    ...files(row.files).map((file) => ({ kind: "file" as const, label: file.name, path: file.path, ...meta })),
    ...links(row.body).map((link) => ({ kind: "link" as const, ...link, ...meta })),
  ]
}

export namespace RayaTaskInfo {
  export function make(database: Database.Interface) {
    const db = database.db
    const share = Effect.fn("RayaTaskInfo.shares")(function* (agentID: string, value?: string, limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        return yield* new Invalid({ message: "Routine info pages are limited to 50 items." })
      const raw = yield* cursor(value)
      const anchor =
        raw === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(ShareCursor)(raw).pipe(
              Effect.mapError(() => new Invalid({ message: "This routine info cursor is invalid." })),
            )
      const rows = yield* db
        .select()
        .from(Message)
        .where(
          and(
            eq(Message.agent_id, agentID),
            anchor
              ? or(
                  lt(Message.time_created, anchor.time),
                  and(eq(Message.time_created, anchor.time), sql`${Message.id} <= ${anchor.id}`),
                )
              : undefined,
          ),
        )
        .orderBy(desc(Message.time_created), desc(Message.id))
        .limit(CAP + 1)
        .all()
        .pipe(Effect.orDie)
      const found: { item: Share; next: string }[] = []
      const scan = rows.slice(0, CAP)
      for (const row of scan) {
        const items = shares(row)
        const start = anchor && row.id === anchor.id && row.time_created === anchor.time ? anchor.skip : 0
        for (let i = start; i < items.length; i++) {
          const item = items[i]
          if (!item) continue
          found.push({ item, next: encode({ section: "shares", time: row.time_created, id: row.id, skip: i + 1 }) })
          if (found.length > limit) break
        }
        if (found.length > limit) break
      }
      const items = found.slice(0, limit)
      if (found.length > limit)
        return { section: "shares" as const, items: items.map((item) => item.item), next: items.at(-1)!.next }
      if (rows.length > CAP && scan.at(-1)) {
        const last = scan.at(-1)!
        return {
          section: "shares" as const,
          items: items.map((item) => item.item),
          next: encode({ section: "shares", time: last.time_created, id: last.id, skip: shares(last).length }),
        }
      }
      return { section: "shares" as const, items: items.map((item) => item.item) }
    })

    const contact = Effect.fn("RayaTaskInfo.contacts")(function* (
      agentID: string,
      resolve: (id: string) => Effect.Effect<Identity>,
      value?: string,
      limit = 50,
    ) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        return yield* new Invalid({ message: "Routine info pages are limited to 50 items." })
      const raw = yield* cursor(value)
      const anchor =
        raw === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(ContactCursor)(raw).pipe(
              Effect.mapError(() => new Invalid({ message: "This routine info cursor is invalid." })),
            )
      const rows = yield* db
        .select()
        .from(Delegation)
        .where(
          and(
            or(eq(Delegation.sender_id, agentID), eq(Delegation.recipient_id, agentID)),
            anchor
              ? or(
                  lt(Delegation.time_created, anchor.time),
                  and(eq(Delegation.time_created, anchor.time), lt(Delegation.id, anchor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(Delegation.time_created), desc(Delegation.id))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const slice = rows.slice(0, limit)
      const items: Contact[] = []
      for (const row of slice) {
        const sent = row.sender_id === agentID
        const peerID = sent ? row.recipient_id : row.sender_id
        const identity = yield* resolve(peerID)
        items.push({
          peerID,
          ...identity,
          direction: sent ? "sent" : "received",
          delegationID: row.id,
          source: row.source,
          state: row.state,
          objective: row.objective,
          ...(row.expected ? { expected: row.expected } : {}),
          ...(row.context ? { context: row.context } : {}),
          ...(row.parent_id ? { parentID: row.parent_id } : {}),
          ...(row.parent_run_id ? { parentRunID: row.parent_run_id } : {}),
          ...(row.deadline !== null ? { deadline: row.deadline } : {}),
          ...(row.budget !== null ? { budget: row.budget } : {}),
          time: row.time_created,
          updated: row.time_updated,
          ...(row.response ? { response: row.response } : {}),
          ...(row.reason ? { reason: row.reason } : {}),
          ...(row.cost !== null ? { cost: row.cost } : {}),
          ...(row.child_run_id ? { occurrenceID: row.child_run_id } : {}),
          ...(row.session_id ? { sessionID: SessionID.make(row.session_id) } : {}),
        })
      }
      const last = slice.at(-1)
      return {
        section: "contacts" as const,
        items,
        ...(rows.length > limit && last
          ? { next: encode({ section: "contacts", time: last.time_created, id: last.id }) }
          : {}),
      }
    })
    return { shares: share, contacts: contact }
  }
}
