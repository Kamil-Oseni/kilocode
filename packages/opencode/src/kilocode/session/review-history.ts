import type { Database } from "@opencode-ai/core/database/database"
import { PartTable } from "@opencode-ai/core/session/sql"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { SessionID } from "@/session/schema"

const Data = Schema.Struct({ files: Schema.Array(Schema.String) })

/** Read only patch metadata; review does not need transcript text or tool output. */
export const patches = Effect.fn("ReviewHistory.patches")(function* (db: Database.Interface["db"], session: SessionID) {
  const rows = yield* db
    .select({ message: PartTable.message_id, part: PartTable.id, data: PartTable.data })
    .from(PartTable)
    .where(and(eq(PartTable.session_id, session), sql`json_extract(${PartTable.data}, '$.type') = 'patch'`))
    .all()
    .pipe(Effect.orDie)
  return yield* Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(Data)(row.data).pipe(
      Effect.map((data) => ({ message: row.message, generation: `${row.message}:${row.part}`, files: data.files })),
      Effect.orDie,
    ),
  )
})
