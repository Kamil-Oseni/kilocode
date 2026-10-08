import { Database } from "@opencode-ai/core/database/database"
import { MessageTable } from "@opencode-ai/core/session/sql"
import * as MessageV2 from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { and, asc, eq, gt, gte, lt, lte, or } from "drizzle-orm"
import { Effect } from "effect"
import { source } from "./capture-source"

/** Anchor to the original turn; later conversation growth cannot replace or evict it. */
export const load = Effect.fn("SecondBrain.captureSource")(function* (session: SessionID, message: string) {
  const { db } = yield* Database.Service
  const end = yield* db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, session), eq(MessageTable.id, MessageID.make(message))))
    .get()
    .pipe(Effect.orDie)
  if (!end || end.data.role !== "assistant") return undefined
  const reply = yield* MessageV2.get({ sessionID: session, messageID: end.id })
  if (reply.info.role !== "assistant") return undefined
  const start = yield* db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, session), eq(MessageTable.id, reply.info.parentID)))
    .get()
    .pipe(Effect.orDie)
  if (!start || start.data.role !== "user") return undefined
  const rows = yield* db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(
      and(
        eq(MessageTable.session_id, session),
        or(
          gt(MessageTable.time_created, start.time_created),
          and(eq(MessageTable.time_created, start.time_created), gte(MessageTable.id, start.id)),
        ),
        or(
          lt(MessageTable.time_created, end.time_created),
          and(eq(MessageTable.time_created, end.time_created), lte(MessageTable.id, end.id)),
        ),
      ),
    )
    .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
    .limit(65)
    .all()
    .pipe(Effect.orDie)
  if (rows.length > 64) throw new Error("Personal capture omitted: original turn exceeds 64 stored messages")
  const messages = yield* Effect.forEach(rows, (row) => MessageV2.get({ sessionID: session, messageID: row.id }))
  return source(messages, session, message)
})
