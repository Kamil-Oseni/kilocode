import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { z } from "zod"
import type { Database } from "@opencode-ai/core/database/database"
import { ResultNotice as Table } from "@opencode-ai/core/kilocode/result-notice.sql"

const id = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 256 && !value.includes("\0"))
const sha = z.string().regex(/^[a-f0-9]{64}$/)
export const schema = z
  .object({
    version: z.literal(1),
    root: z
      .object({
        sessionID: id,
        userID: id,
        sha,
        authority: sha,
        current: id,
        route: z.object({ messageID: id, partID: id, callID: id }).strict(),
      })
      .strict(),
    row: z.object({ messageID: id, sha }).strict(),
    job: z.object({ id, revision: id, callID: id, inputID: id, identitySHA: sha, terminalSHA: sha }).strict(),
    source: z
      .object({
        task: sha,
        child: sha,
        input: sha,
        terminal: sha,
        reads: z.array(z.object({ id, sha }).strict()).max(16),
      })
      .strict(),
  })
  .strict()
export type Receipt = z.infer<typeof schema>

function encode(value: Receipt) {
  const body = JSON.stringify(schema.parse(value))
  if (Buffer.byteLength(body, "utf8") > 256 * 1024) throw new Error("Result notice receipt exceeded bound")
  return { body, sha: createHash("sha256").update(body).digest("hex") }
}

/** Only the original local event commit writes; reads never register or reinject a notice. */
export function make(database: Database.Interface) {
  const db = database.db
  const where = (input: { sessionID: string; messageID: string }) =>
    and(eq(Table.sessionID, input.sessionID), eq(Table.messageID, input.messageID))
  const get = Effect.fn("ResultNotice.get")(function* (input: { sessionID: string; messageID: string }) {
    id.parse(input.sessionID)
    id.parse(input.messageID)
    const size = yield* db
      .select({ bytes: sql<number>`length(CAST(${Table.body} AS BLOB))` })
      .from(Table)
      .where(where(input))
      .get()
      .pipe(Effect.orDie)
    if (!size) return undefined
    if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > 256 * 1024)
      throw new Error("Result notice receipt exceeded bound")
    const row = yield* db
      .select({
        sessionID: Table.sessionID,
        messageID: Table.messageID,
        userID: Table.userID,
        jobID: Table.jobID,
        revision: Table.revision,
        callID: Table.callID,
        inputID: Table.inputID,
        sha: Table.sha,
        body: sql<
          string | null
        >`CASE WHEN length(CAST(${Table.body} AS BLOB)) BETWEEN 1 AND 262144 THEN ${Table.body} ELSE NULL END`,
      })
      .from(Table)
      .where(where(input))
      .get()
      .pipe(Effect.orDie)
    if (!row) throw new Error("Result notice receipt disappeared")
    if (row.body === null || Buffer.byteLength(row.body, "utf8") > 256 * 1024)
      throw new Error("Result notice receipt exceeded bound")
    const value = schema.parse(JSON.parse(row.body))
    const encoded = encode(value)
    if (
      encoded.body !== row.body ||
      encoded.sha !== row.sha ||
      value.root.sessionID !== row.sessionID ||
      value.root.userID !== row.userID ||
      value.row.messageID !== row.messageID ||
      value.job.id !== row.jobID ||
      value.job.revision !== row.revision ||
      value.job.callID !== row.callID ||
      value.job.inputID !== row.inputID
    )
      throw new Error("Result notice receipt changed")
    return value
  })
  const insert = Effect.fn("ResultNotice.insert")(function* (value: Receipt) {
    const encoded = encode(value)
    const prior = yield* get({ sessionID: value.root.sessionID, messageID: value.row.messageID })
    if (prior) throw new Error("Result notice was already committed")
    const original = yield* db
      .select({ messageID: Table.messageID })
      .from(Table)
      .where(
        and(
          eq(Table.jobID, value.job.id),
          eq(Table.revision, value.job.revision),
          eq(Table.callID, value.job.callID),
          eq(Table.inputID, value.job.inputID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (original) throw new Error("Result notice original completion was already committed")
    const count = yield* db
      .select({ count: sql<number>`count(*)` })
      .from(Table)
      .where(and(eq(Table.sessionID, value.root.sessionID), eq(Table.userID, value.root.userID)))
      .get()
      .pipe(Effect.orDie)
    if (!count || !Number.isSafeInteger(count.count) || count.count < 0 || count.count >= 16)
      throw new Error("Result notice receipt capacity exceeded")
    yield* db
      .insert(Table)
      .values({
        sessionID: value.root.sessionID,
        messageID: value.row.messageID,
        userID: value.root.userID,
        jobID: value.job.id,
        revision: value.job.revision,
        callID: value.job.callID,
        inputID: value.job.inputID,
        body: encoded.body,
        sha: encoded.sha,
      })
      .run()
      .pipe(Effect.orDie)
    const retained = yield* get({ sessionID: value.root.sessionID, messageID: value.row.messageID })
    if (!retained || encode(retained).sha !== encoded.sha)
      throw new Error("Result notice receipt acknowledgement changed")
  })
  return { get, insert }
}
