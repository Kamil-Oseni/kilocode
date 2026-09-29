import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, SessionID } from "@/session/schema"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"

/** Read canonical ownership without recreating or changing a tool part. */
export const check = Effect.fn("BrowserOrigin.check")(function* (
  input: { sessionID: string; messageID: string; callID: string; tool: string; partID?: string },
  directory: string,
  live: boolean,
) {
  if (!Schema.is(SessionID)(input.sessionID) || !Schema.is(MessageID)(input.messageID)) return
  if (!input.callID || !input.tool || !directory || input.partID === "") return
  if (!live && !input.partID) return
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({ part: PartTable, message: MessageTable.data, directory: SessionTable.directory })
    .from(PartTable)
    .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
    .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
    .where(
      and(
        eq(SessionTable.id, SessionID.make(input.sessionID)),
        eq(MessageTable.id, MessageID.make(input.messageID)),
        eq(PartTable.session_id, SessionID.make(input.sessionID)),
        sql`json_extract(${PartTable.data}, '$.callID') = ${input.callID}`,
      ),
    )
    .limit(2)
    .all()
    .pipe(Effect.orDie)
  if (rows.length !== 1) return
  const row = rows[0]!
  if (row.directory !== directory || row.message.role !== "assistant") return
  const part = {
    ...row.part.data,
    id: row.part.id,
    sessionID: row.part.session_id,
    messageID: row.part.message_id,
  }
  if (!Schema.is(SessionV1.ToolPart)(part)) return
  if (part.callID !== input.callID || part.tool !== input.tool) return
  if (input.partID !== undefined && part.id !== input.partID) return
  if (live && part.state.status !== "pending" && part.state.status !== "running") return
  return part.id
})
