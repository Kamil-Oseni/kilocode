import { and, asc, count, desc, eq, gt, isNull, ne, sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import { Effect, Exit, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineConversationTable as Conversation,
  RayaRoutineAttachmentTable as Attachment,
  RayaRoutineMessageTable as Message,
} from "@opencode-ai/core/kilocode/routine.sql"
import { SessionID } from "@/session/schema"
import { RayaTask } from "./index"

const token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.:-]{1,128}$/))
const text = Schema.String.check(Schema.isMaxLength(8000))
const Kind = Schema.Literals(["user", "worker", "report", "decision", "delegation"])
export const State = Schema.Literals(["scheduled", "running", "waiting", "needs_input", "paused", "failed"])
export const Clip = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
})
const MAX_SIZE = 5 * 1024 * 1024
const MAX_TOTAL = 20 * 1024 * 1024
const Name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((value) =>
    value === value.trim() && !/[\\/\u0000-\u001f\u007f]/.test(value)
      ? undefined
      : "Attachment names must be plain file names.",
  ),
)
const Mime = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
)
export const Upload = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  name: Name,
  mime: Mime,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_SIZE)),
  data: Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(Math.ceil(MAX_SIZE / 3) * 4)),
}).check(
  Schema.makeFilter((file) => {
    if (file.data.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(file.data))
      return "Routine attachments must contain valid base64 data."
    const bytes = Buffer.from(file.data, "base64")
    if (bytes.byteLength !== file.size || bytes.toString("base64") !== file.data)
      return "Routine attachment size or base64 data does not match."
  }),
)
export const AttachmentMeta = Schema.Struct({
  id: Upload.fields.id,
  name: Name,
  mime: Mime,
  size: Upload.fields.size,
})
export const AttachmentContent = Schema.Struct({ ...AttachmentMeta.fields, data: Upload.fields.data })
const Files = Schema.Array(Clip).check(Schema.isMinLength(1), Schema.isMaxLength(8))
const Attachments = Schema.Array(AttachmentMeta).check(Schema.isMinLength(1), Schema.isMaxLength(8))
const AttachmentIDs = Schema.Array(Upload.fields.id).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8),
  Schema.makeFilter((ids) => (new Set(ids).size === ids.length ? undefined : "Attachment IDs must be unique.")),
)
const DraftAttachmentIDs = Schema.Array(Upload.fields.id).check(
  Schema.isMaxLength(8),
  Schema.makeFilter((ids) => (new Set(ids).size === ids.length ? undefined : "Attachment IDs must be unique.")),
)
const Uploads = Schema.Array(Upload).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8),
  Schema.makeFilter((files) =>
    files.reduce((size, file) => size + file.size, 0) <= MAX_TOTAL
      ? undefined
      : "Routine attachments are limited to 20 MB in one message.",
  ),
)
const DraftUploads = Schema.Array(Upload).check(
  Schema.isMaxLength(8),
  Schema.makeFilter((files) =>
    files.reduce((size, file) => size + file.size, 0) <= MAX_TOTAL
      ? undefined
      : "Routine attachments are limited to 20 MB in one draft.",
  ),
)
const decodeFiles = Schema.decodeUnknownExit(Files)
const decodeAttachments = Schema.decodeUnknownExit(Attachments)
export const Record = Schema.Struct({
  id: token,
  agentID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  kind: Kind,
  source: token,
  body: text,
  occurrenceID: Schema.optional(token),
  sessionID: Schema.optional(SessionID),
  files: Schema.optional(Files),
  attachments: Schema.optional(Attachments),
  time: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8.64e15)),
})
export const Publish = Schema.Struct({
  agentID: Record.fields.agentID,
  source: token,
  kind: Kind,
  body: text,
  occurrenceID: Schema.optional(token),
  sessionID: Schema.optional(SessionID),
  files: Schema.optional(Files),
  attachments: Schema.optional(Uploads),
  attachmentIDs: Schema.optional(AttachmentIDs),
}).check(
  Schema.makeFilter((value) =>
    value.body.trim() || (value.kind === "user" && (value.attachments?.length || value.attachmentIDs?.length))
      ? undefined
      : "Routine inbox messages need a non-empty body or user attachment.",
  ),
  Schema.makeFilter((value) =>
    value.attachments?.length && value.attachmentIDs?.length
      ? "Send staged attachment IDs or new attachment content, not both."
      : undefined,
  ),
)
export const Send = Schema.Struct({
  source: token,
  body: text,
  attachments: Schema.optional(Uploads),
  attachmentIDs: Schema.optional(AttachmentIDs),
}).check(
  Schema.makeFilter((value) =>
    value.body.trim() || value.attachments?.length || value.attachmentIDs?.length
      ? undefined
      : "Write a follow-up or attach a file before sending.",
  ),
  Schema.makeFilter((value) =>
    value.attachments?.length && value.attachmentIDs?.length
      ? "Send staged attachment IDs or new attachment content, not both."
      : undefined,
  ),
)
export const Read = Schema.Struct({
  at: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8.64e15)),
})
export const Draft = Schema.Struct({
  draft: Schema.Union([Schema.String.check(Schema.isMaxLength(8000)), Schema.Null]),
  attachments: Schema.optional(DraftUploads),
  attachmentIDs: Schema.optional(DraftAttachmentIDs),
}).check(
  Schema.makeFilter((value) => {
    if (value.attachments === undefined && value.attachmentIDs === undefined) return
    const ids = [...(value.attachmentIDs ?? []), ...(value.attachments ?? []).map((file) => file.id)]
    if (ids.length > 8) return "Routine drafts are limited to 8 attachments."
    if (new Set(ids).size !== ids.length) return "Draft attachment IDs must be unique."
  }),
)
export const DraftState = Schema.Struct({
  draft: Draft.fields.draft,
  attachments: Schema.optional(Attachments),
})
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
  draftAttachments: Schema.optional(Attachments),
})
export type Record = typeof Record.Type
export type Publish = typeof Publish.Type
export type Upload = typeof Upload.Type
export type AttachmentMeta = typeof AttachmentMeta.Type
export type AttachmentContent = typeof AttachmentContent.Type
export type Draft = typeof Draft.Type
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

function checksum(value: string) {
  return createHash("sha256").update(value, "base64").digest("hex")
}

function same(row: typeof Attachment.$inferSelect, file: Upload) {
  return (
    row.name === file.name && row.mime === file.mime && row.size === file.size && row.sha256 === checksum(file.data)
  )
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

function packed(rows?: readonly (typeof Clip.Type)[]) {
  if (!rows?.length) return null
  return JSON.stringify(rows)
}

function metadata(rows?: readonly Upload[]) {
  if (!rows?.length) return
  return rows.map((file) => ({ id: file.id, name: file.name, mime: file.mime, size: file.size }))
}

function packedAttachments(rows?: readonly AttachmentMeta[]) {
  if (!rows?.length) return null
  return JSON.stringify(rows)
}

function listed(raw: string | null) {
  if (!raw || raw[0] !== "[") return
  const decoded = decodeFiles(JSON.parse(raw))
  if (!Exit.isSuccess(decoded)) return
  return decoded.value
}

function listedAttachments(raw: string | null) {
  if (!raw || raw[0] !== "[") return
  const decoded = decodeAttachments(JSON.parse(raw))
  if (!Exit.isSuccess(decoded)) return
  return decoded.value
}

function matched(left?: readonly (typeof Clip.Type)[], right?: readonly (typeof Clip.Type)[]) {
  return packed(left) === packed(right)
}

function matchedAttachments(left?: readonly AttachmentMeta[], right?: readonly AttachmentMeta[]) {
  return packedAttachments(left) === packedAttachments(right)
}

export function paths(rows?: readonly string[]) {
  if (!rows?.length) return
  const items: (typeof Clip.Type)[] = []
  for (const row of rows.slice(0, 8)) {
    const path = row.trim()
    if (!path || /\s/.test(path)) continue
    const leaf = path.replaceAll("\\", "/").split("/").at(-1)
    if (!leaf || !/\.[A-Za-z0-9]{1,8}$/.test(leaf)) continue
    items.push({ name: leaf.slice(0, 256), path: path.slice(0, 1024) })
  }
  return items.length ? items : undefined
}

function decode(row: typeof Message.$inferSelect): Record {
  const files = listed(row.files)
  const attachments = listedAttachments(row.attachments)
  return {
    id: row.id,
    agentID: row.agent_id,
    kind: row.kind,
    source: row.source,
    body: row.body,
    time: row.time_created,
    ...(row.occurrence_id ? { occurrenceID: row.occurrence_id } : {}),
    ...(row.session_id ? { sessionID: SessionID.make(row.session_id) } : {}),
    ...(files ? { files } : {}),
    ...(attachments ? { attachments } : {}),
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

function origin(kind: "need" | "report", id: string) {
  const raw = `${kind}:${id}`
  return Schema.is(token)(raw) ? raw : `${kind}:${digest(id).slice(0, 40)}`
}

export function posted(run: RayaTask.Run): Publish | undefined {
  if (run.status === "running") return undefined
  const waiting = run.status === "blocked" && run.blockedReason === "waiting on you"
  const at = run.trigger?.kind === "timer" ? run.trigger.scheduledAt : run.at
  const when = Number.isFinite(at) ? new Date(at).toISOString() : "unknown time"
  const findings = run.outcome?.summary?.trim()
  const reason = run.blockedReason?.trim()
  const lines = waiting
    ? [`This run needs a decision (${when}).`, reason, "This is not a completed report."]
    : run.status === "complete"
      ? [
          `Run completed (${when}).`,
          findings || "No written findings were saved. Inspect the run details; this is not invented success.",
        ]
      : [
          `Run ${run.status} (${when}).`,
          reason || findings || "No written findings were saved.",
          "This is not a completed report.",
        ]
  if (run.outcome?.evidence?.length) lines.push("Evidence:", ...run.outcome.evidence.slice(0, 8))
  const body = lines
    .filter((line): line is string => !!line)
    .join("\n")
    .slice(0, 8000)
  if (!body.trim()) return undefined
  const files = paths(run.outcome?.evidence)
  return {
    agentID: run.agentID,
    source: origin(waiting ? "need" : "report", run.id),
    kind: waiting ? "decision" : "report",
    body,
    sessionID: run.sessionID,
    ...(Schema.is(token)(run.id) ? { occurrenceID: run.id } : {}),
    ...(files ? { files } : {}),
  }
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
        .pipe(Effect.orDie)
      const row = yield* db
        .select()
        .from(Conversation)
        .where(eq(Conversation.agent_id, agentID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error("Routine conversation could not be created."))
      return row
    })
    const admit = Effect.fn("RayaTaskInbox.admit")(function* (input: Publish) {
      const value = yield* Schema.decodeUnknownEffect(Publish)(input).pipe(
        Effect.mapError(
          () => new Invalid({ message: "Routine inbox messages need a stable source and valid content." }),
        ),
      )
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(Conversation)
                .values({ agent_id: value.agentID, id: key(value.agentID), read_at: 0, time_updated: Date.now() })
                .onConflictDoNothing()
                .run()
                .pipe(Effect.orDie)
              const prior = yield* tx
                .select()
                .from(Message)
                .where(and(eq(Message.agent_id, value.agentID), eq(Message.source, value.source)))
                .get()
                .pipe(Effect.orDie)
              if (prior) {
                const saved = decode(prior)
                const content = yield* tx
                  .select()
                  .from(Attachment)
                  .where(and(eq(Attachment.agent_id, value.agentID), eq(Attachment.message_id, prior.id)))
                  .orderBy(asc(Attachment.time_created), asc(Attachment.id))
                  .all()
                  .pipe(Effect.orDie)
                const ids = saved.attachments?.map((file) => file.id) ?? []
                const expected = value.attachmentIDs ?? value.attachments?.map((file) => file.id) ?? []
                const valid = value.attachments
                  ? value.attachments.every((file) => content.some((row) => row.id === file.id && same(row, file)))
                  : true
                if (
                  saved.kind !== value.kind ||
                  saved.body !== value.body ||
                  saved.occurrenceID !== value.occurrenceID ||
                  !matched(saved.files, value.files) ||
                  JSON.stringify(ids) !== JSON.stringify(expected) ||
                  content.length !== expected.length ||
                  !valid ||
                  (value.sessionID !== undefined && saved.sessionID !== value.sessionID)
                )
                  return yield* new Conflict({ message: "This inbox source already has a different message." })
                const conversation = yield* tx
                  .select()
                  .from(Conversation)
                  .where(eq(Conversation.agent_id, value.agentID))
                  .get()
                  .pipe(Effect.orDie)
                const sent = new Set(expected)
                const remaining = listedAttachments(conversation?.draft_attachments ?? null)?.filter(
                  (file) => !sent.has(file.id),
                )
                yield* tx
                  .update(Conversation)
                  .set({
                    ...(conversation?.draft === value.body ? { draft: null } : {}),
                    draft_attachments: packedAttachments(remaining),
                    time_updated: Date.now(),
                  })
                  .where(eq(Conversation.agent_id, value.agentID))
                  .run()
                  .pipe(Effect.orDie)
                return { record: saved, created: false }
              }
              if (value.kind === "user") {
                const pending = yield* tx
                  .select({ id: Message.id })
                  .from(Message)
                  .where(and(eq(Message.agent_id, value.agentID), eq(Message.kind, "user"), isNull(Message.session_id)))
                  .limit(1)
                  .get()
                  .pipe(Effect.orDie)
                if (pending)
                  return yield* new Conflict({ message: "This worker already has a follow-up waiting for dispatch." })
              }
              const staged: Upload[] = []
              for (const id of value.attachmentIDs ?? []) {
                const file = yield* tx
                  .select()
                  .from(Attachment)
                  .where(
                    and(eq(Attachment.id, id), eq(Attachment.agent_id, value.agentID), isNull(Attachment.message_id)),
                  )
                  .get()
                  .pipe(Effect.orDie)
                if (!file)
                  return yield* new Conflict({
                    message: "A staged attachment is missing or belongs to another worker.",
                  })
                staged.push({ id: file.id, name: file.name, mime: file.mime, size: file.size, data: file.data })
              }
              const uploads = value.attachments ?? staged
              const now = Date.now()
              const row = {
                id: receipt(value.agentID, value.source),
                agent_id: value.agentID,
                source: value.source,
                kind: value.kind,
                body: value.body,
                occurrence_id: value.occurrenceID ?? null,
                session_id: value.sessionID ?? null,
                files: packed(value.files),
                attachments: packedAttachments(metadata(uploads)),
                delivery_id: null,
                delivered_at: null,
                time_created: now,
              }
              yield* tx.insert(Message).values(row).run().pipe(Effect.orDie)
              for (const file of uploads) {
                const prior = yield* tx
                  .select()
                  .from(Attachment)
                  .where(eq(Attachment.id, file.id))
                  .get()
                  .pipe(Effect.orDie)
                if (prior) {
                  if (prior.agent_id !== value.agentID || prior.message_id !== null || !same(prior, file))
                    return yield* new Conflict({ message: "This attachment is already used by another message." })
                  yield* tx
                    .update(Attachment)
                    .set({ message_id: row.id })
                    .where(
                      and(
                        eq(Attachment.id, file.id),
                        eq(Attachment.agent_id, value.agentID),
                        isNull(Attachment.message_id),
                      ),
                    )
                    .run()
                    .pipe(Effect.orDie)
                  continue
                }
                yield* tx
                  .insert(Attachment)
                  .values({
                    id: file.id,
                    agent_id: value.agentID,
                    message_id: row.id,
                    name: file.name,
                    mime: file.mime,
                    size: file.size,
                    data: file.data,
                    sha256: checksum(file.data),
                    time_created: now,
                  })
                  .run()
                  .pipe(Effect.orDie)
              }
              const conversation = yield* tx
                .select()
                .from(Conversation)
                .where(eq(Conversation.agent_id, value.agentID))
                .get()
                .pipe(Effect.orDie)
              const sent = new Set(uploads.map((file) => file.id))
              const remaining = listedAttachments(conversation?.draft_attachments ?? null)?.filter(
                (file) => !sent.has(file.id),
              )
              yield* tx
                .update(Conversation)
                .set({
                  ...(conversation?.draft === value.body ? { draft: null } : {}),
                  draft_attachments: packedAttachments(remaining),
                  time_updated: now,
                })
                .where(eq(Conversation.agent_id, value.agentID))
                .run()
                .pipe(Effect.orDie)
              return { record: decode(row), created: true }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })
    const publish = Effect.fn("RayaTaskInbox.publish")(function* (input: Publish) {
      return (yield* admit(input)).record
    })
    const attach = Effect.fn("RayaTaskInbox.attach")(function* (agentID: string, source: string, sessionID: SessionID) {
      const prior = yield* db
        .select()
        .from(Message)
        .where(and(eq(Message.agent_id, agentID), eq(Message.source, source)))
        .get()
        .pipe(Effect.orDie)
      if (!prior) return yield* new Invalid({ message: "This inbox message was not found." })
      if (prior.session_id && prior.session_id !== sessionID)
        return yield* new Conflict({ message: "This inbox message is already attached to another session." })
      if (prior.session_id === sessionID) return decode(prior)
      yield* db
        .update(Message)
        .set({ session_id: sessionID })
        .where(and(eq(Message.agent_id, agentID), eq(Message.source, source)))
        .run()
        .pipe(Effect.orDie)
      return decode({ ...prior, session_id: sessionID })
    })
    const delivery = Effect.fn("RayaTaskInbox.delivery")(function* (sessionID: SessionID, messageID: string) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const bound = yield* tx
                .select()
                .from(Message)
                .where(and(eq(Message.session_id, sessionID), eq(Message.delivery_id, messageID)))
                .get()
                .pipe(Effect.orDie)
              const row =
                bound ??
                (yield* tx
                  .select()
                  .from(Message)
                  .where(
                    and(
                      eq(Message.session_id, sessionID),
                      eq(Message.kind, "user"),
                      isNull(Message.delivery_id),
                      isNull(Message.delivered_at),
                    ),
                  )
                  .orderBy(asc(Message.time_created), asc(Message.id))
                  .limit(1)
                  .get()
                  .pipe(Effect.orDie))
              if (!row) return
              if (!bound) {
                yield* tx
                  .update(Message)
                  .set({ delivery_id: messageID })
                  .where(and(eq(Message.id, row.id), isNull(Message.delivery_id), isNull(Message.delivered_at)))
                  .run()
                  .pipe(Effect.orDie)
              }
              const files = yield* tx
                .select()
                .from(Attachment)
                .where(and(eq(Attachment.agent_id, row.agent_id), eq(Attachment.message_id, row.id)))
                .orderBy(asc(Attachment.time_created), asc(Attachment.id))
                .all()
                .pipe(Effect.orDie)
              return {
                record: decode({ ...row, delivery_id: messageID }),
                delivered: row.delivered_at !== null,
                files: files.map((file) => ({
                  type: "file" as const,
                  mime: file.mime,
                  filename: file.name,
                  url: `data:${file.mime};base64,${file.data}`,
                })),
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })
    const delivered = Effect.fn("RayaTaskInbox.delivered")(function* (sessionID: SessionID, messageID: string) {
      yield* db
        .update(Message)
        .set({ delivered_at: Date.now() })
        .where(and(eq(Message.session_id, sessionID), eq(Message.delivery_id, messageID), isNull(Message.delivered_at)))
        .run()
        .pipe(Effect.orDie)
    })
    const content = Effect.fn("RayaTaskInbox.content")(function* (agentID: string, id: string) {
      const row = yield* db
        .select()
        .from(Attachment)
        .where(and(eq(Attachment.agent_id, agentID), eq(Attachment.id, id)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return { id: row.id, name: row.name, mime: row.mime, size: row.size, data: row.data } satisfies AttachmentContent
    })
    const pending = Effect.fn("RayaTaskInbox.pending")(function* (agentID: string) {
      const row = yield* db
        .select()
        .from(Message)
        .where(and(eq(Message.agent_id, agentID), eq(Message.kind, "user"), isNull(Message.session_id)))
        .orderBy(asc(Message.time_created), asc(Message.id))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })
    const page = Effect.fn("RayaTaskInbox.page")(function* (agentID: string, cursor?: string, limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        return yield* new Invalid({ message: "Inbox pages are limited to 50 messages." })
      yield* ensure(agentID)
      const parsed = marker(cursor)
      if (!parsed.ok) return yield* new Invalid({ message: "This inbox page cursor is invalid." })
      const rows = yield* (
        "id" in parsed
          ? db
              .select()
              .from(Message)
              .where(
                and(
                  eq(Message.agent_id, agentID),
                  sql`(${Message.time_created} < ${parsed.time} or (${Message.time_created} = ${parsed.time} and ${Message.id} < ${parsed.id}))`,
                ),
              )
          : db.select().from(Message).where(eq(Message.agent_id, agentID))
      )
        .orderBy(desc(Message.time_created), desc(Message.id))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const extra = rows.length > limit
      const slice = rows.slice(0, limit).reverse()
      return {
        messages: slice.map(decode),
        ...(extra && slice[0] ? { next: `${slice[0].time_created}:${slice[0].id}` } : {}),
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
        .pipe(Effect.orDie)
      return at
    })
    const draft = Effect.fn("RayaTaskInbox.draft")(function* (agentID: string, input: Draft) {
      const value = yield* Schema.decodeUnknownEffect(Draft)(input).pipe(
        Effect.mapError(() => new Invalid({ message: "Inbox drafts are limited to 8000 characters." })),
      )
      yield* ensure(agentID)
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const saved = value.draft && value.draft.length ? value.draft : null
              const update: { draft: string | null; time_updated: number; draft_attachments?: string | null } = {
                draft: saved,
                time_updated: Date.now(),
              }
              if (value.attachments !== undefined || value.attachmentIDs !== undefined) {
                const files: Upload[] = []
                for (const id of value.attachmentIDs ?? []) {
                  const file = yield* tx
                    .select()
                    .from(Attachment)
                    .where(and(eq(Attachment.id, id), eq(Attachment.agent_id, agentID), isNull(Attachment.message_id)))
                    .get()
                    .pipe(Effect.orDie)
                  if (!file)
                    return yield* new Conflict({
                      message: "A draft attachment is missing or belongs to another worker.",
                    })
                  files.push({ id: file.id, name: file.name, mime: file.mime, size: file.size, data: file.data })
                }
                for (const file of value.attachments ?? []) {
                  const prior = yield* tx
                    .select()
                    .from(Attachment)
                    .where(eq(Attachment.id, file.id))
                    .get()
                    .pipe(Effect.orDie)
                  if (prior && (prior.agent_id !== agentID || prior.message_id !== null || !same(prior, file)))
                    return yield* new Conflict({ message: "This attachment is already used by another message." })
                  files.push(file)
                }
                if (files.length > 8 || files.reduce((size, file) => size + file.size, 0) > MAX_TOTAL)
                  return yield* new Invalid({ message: "Routine drafts allow 8 attachments and 20 MB total." })
                yield* tx
                  .delete(Attachment)
                  .where(and(eq(Attachment.agent_id, agentID), isNull(Attachment.message_id)))
                  .run()
                  .pipe(Effect.orDie)
                for (const file of files) {
                  yield* tx
                    .insert(Attachment)
                    .values({
                      id: file.id,
                      agent_id: agentID,
                      message_id: null,
                      name: file.name,
                      mime: file.mime,
                      size: file.size,
                      data: file.data,
                      sha256: checksum(file.data),
                      time_created: Date.now(),
                    })
                    .run()
                    .pipe(Effect.orDie)
                }
                update.draft_attachments = packedAttachments(metadata(files))
              }
              yield* tx
                .update(Conversation)
                .set(update)
                .where(eq(Conversation.agent_id, agentID))
                .run()
                .pipe(Effect.orDie)
              const row = yield* tx
                .select()
                .from(Conversation)
                .where(eq(Conversation.agent_id, agentID))
                .get()
                .pipe(Effect.orDie)
              const attachments = listedAttachments(row?.draft_attachments ?? null)
              return { draft: saved, ...(attachments ? { attachments } : {}) }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })
    const unread = Effect.fn("RayaTaskInbox.unread")(function* (agentID: string, at: number) {
      const row = yield* db
        .select({ n: count() })
        .from(Message)
        .where(and(eq(Message.agent_id, agentID), ne(Message.kind, "user"), gt(Message.time_created, at)))
        .get()
        .pipe(Effect.orDie)
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
        .pipe(Effect.orDie)
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
          ...(listedAttachments(row.draft_attachments)
            ? { draftAttachments: listedAttachments(row.draft_attachments) }
            : {}),
          ...(agent.nextRun !== undefined ? { nextRun: agent.nextRun } : {}),
          ...(last ? { latest: last } : {}),
        })
      }
      return items
    })
    return { ensure, admit, publish, attach, delivery, delivered, content, pending, page, read, draft, summaries }
  }
}
