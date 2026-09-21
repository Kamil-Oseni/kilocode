import { and, desc, eq, lt, or, sql } from "drizzle-orm"
import { Effect, Exit, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineMessageTable as Message,
} from "@opencode-ai/core/kilocode/routine.sql"
import { SessionID } from "@/session/schema"
import { commitment, direct, standing } from "./commitment"
import { Artifact, artifacts } from "./delegation"
import { AttachmentMeta, Clip, Record as MessageRecord } from "./inbox"

const token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.:-]{1,128}$/))
const stamp = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8.64e15))
const Files = Schema.Array(Clip).check(Schema.isMaxLength(8))
const decoded = Schema.decodeUnknownExit(Files)
const decodedAttachments = Schema.decodeUnknownExit(Schema.Array(AttachmentMeta).check(Schema.isMaxLength(8)))
const CAP = 500
const active = new Set(["queued", "accepted", "running", "needs_input"])

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
    kind: Schema.Literal("attachment"),
    ...ShareBase,
    attachmentID: AttachmentMeta.fields.id,
    mime: AttachmentMeta.fields.mime,
    size: AttachmentMeta.fields.size,
  }),
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
  organizationID: Schema.optional(Schema.String.check(Schema.isPattern(/^org_[a-f0-9]{32}$/))),
  organizationName: Schema.optional(Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(120))),
  organizationRevision: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  ),
  source: token,
  state: Schema.Literals(["queued", "accepted", "running", "needs_input", "completed", "failed", "cancelled"]),
  objective: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(8000)),
  expected: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  parentID: Schema.optional(token),
  parentRunID: Schema.optional(token),
  deadline: Schema.optional(stamp),
  budget: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000))),
  time: stamp,
  updated: stamp,
  response: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  occurrenceID: Schema.optional(token),
  sessionID: Schema.optional(SessionID),
  artifacts: Schema.optional(Schema.Array(Artifact)),
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
const Person = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  name: Schema.String.check(Schema.isMinLength(1)),
  role: Schema.String.check(Schema.isMinLength(1)),
  archived: Schema.Boolean,
})
export const Activity = Schema.Struct({
  id: token,
  sender: Person,
  recipient: Person,
  organizationID: Schema.String.check(Schema.isPattern(/^org_[a-f0-9]{32}$/)),
  organizationName: Schema.optional(Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(120))),
  organizationRevision: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  ),
  source: token,
  state: Contact.fields.state,
  objective: Contact.fields.objective,
  expected: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  parentID: Schema.optional(token),
  parentRunID: Schema.optional(token),
  deadline: Schema.optional(stamp),
  budget: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000))),
  time: stamp,
  updated: stamp,
  response: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  occurrenceID: Schema.optional(token),
  sessionID: Schema.optional(SessionID),
  artifacts: Schema.optional(Schema.Array(Artifact)),
})
export const ActivityPage = Schema.Struct({
  items: Schema.Array(Activity),
  summary: Schema.Struct({
    total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    active: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    needsAttention: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    uncertain: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    recordedCost: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    committedCost: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    standaloneCost: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  }),
  next: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
})
export type Query = typeof Query.Type
export type Share = typeof Share.Type
export type Contact = typeof Contact.Type
export type Page = typeof Page.Type
export type Identity = Pick<Contact, "name" | "role" | "archived">
export type Activity = typeof Activity.Type

const ShareCursor = Schema.Struct({
  section: Schema.Literal("shares"),
  time: stamp,
  id: token,
  skip: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000)),
})
const ContactCursor = Schema.Struct({ section: Schema.Literal("contacts"), time: stamp, id: token })
const ActivityCursor = Schema.Struct({ section: Schema.Literal("activity"), time: stamp, id: token })

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("RayaTaskInfo.Invalid", {
  message: Schema.String,
}) {}

function encode(value: typeof ShareCursor.Type | typeof ContactCursor.Type | typeof ActivityCursor.Type) {
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

function attachments(raw: string | null) {
  if (!raw || raw[0] !== "[") return []
  const result = decodedAttachments(JSON.parse(raw))
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
    ...attachments(row.attachments).map((file) => ({
      kind: "attachment" as const,
      attachmentID: file.id,
      label: file.name,
      mime: file.mime,
      size: file.size,
      ...meta,
    })),
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
        const files = artifacts(row.artifacts)
        items.push({
          peerID,
          ...identity,
          direction: sent ? "sent" : "received",
          delegationID: row.id,
          ...(row.organization_id ? { organizationID: row.organization_id } : {}),
          ...(row.organization_name ? { organizationName: row.organization_name } : {}),
          ...(row.organization_revision !== null ? { organizationRevision: row.organization_revision } : {}),
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
          ...(files ? { artifacts: files } : {}),
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
    const activity = Effect.fn("RayaTaskInfo.activity")(function* (
      organizationID: string,
      resolve: (id: string) => Effect.Effect<Identity>,
      value?: string,
      limit = 50,
    ) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        return yield* new Invalid({ message: "Organization activity pages are limited to 50 items." })
      const raw = yield* cursor(value)
      const anchor =
        raw === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(ActivityCursor)(raw).pipe(
              Effect.mapError(() => new Invalid({ message: "This organization activity cursor is invalid." })),
            )
      const rows = yield* db
        .select()
        .from(Delegation)
        .where(
          and(
            eq(Delegation.organization_id, organizationID),
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
      const all = yield* db
        .select()
        .from(Delegation)
        .where(eq(Delegation.organization_id, organizationID))
        .all()
        .pipe(Effect.orDie)
      const committedCost = commitment(all)
      const directCost = yield* direct(db, organizationID).pipe(Effect.orDie)
      const held = yield* standing(db, organizationID).pipe(Effect.orDie)
      const standaloneCost = directCost + held.recorded
      const summary = {
        total: all.length,
        active: all.filter((row) => active.has(row.state)).length,
        needsAttention: all.filter((row) => row.state === "needs_input" || row.state === "failed").length,
        uncertain: all.filter((row) => !active.has(row.state) && row.session_id !== null && row.cost === null).length,
        recordedCost: all.reduce((total, row) => total + (row.cost ?? 0), standaloneCost),
        committedCost: committedCost + directCost + held.committed,
        standaloneCost,
      }
      const slice = rows.slice(0, limit)
      const items: Activity[] = []
      for (const row of slice) {
        const sender = yield* resolve(row.sender_id)
        const recipient = yield* resolve(row.recipient_id)
        const files = artifacts(row.artifacts)
        items.push({
          id: row.id,
          sender: { id: row.sender_id, ...sender },
          recipient: { id: row.recipient_id, ...recipient },
          organizationID,
          ...(row.organization_name ? { organizationName: row.organization_name } : {}),
          ...(row.organization_revision !== null ? { organizationRevision: row.organization_revision } : {}),
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
          ...(files ? { artifacts: files } : {}),
        })
      }
      const last = slice.at(-1)
      return {
        items,
        summary,
        ...(rows.length > limit && last
          ? { next: encode({ section: "activity", time: last.time_created, id: last.id }) }
          : {}),
      }
    })
    return { shares: share, contacts: contact, activity }
  }
}
