import { sql } from "drizzle-orm"
import { check, index, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"

/** A locally committed observation receipt is not a producer admission. */
export const ResultNotice = sqliteTable(
  "raya_result_notice",
  {
    sessionID: text("session_id")
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    messageID: text("message_id").notNull(),
    userID: text("user_id").notNull(),
    jobID: text("job_id").notNull(),
    revision: text().notNull(),
    callID: text("call_id").notNull(),
    inputID: text("input_id").notNull(),
    body: text().notNull(),
    sha: text().notNull(),
  },
  (row) => [
    primaryKey({ columns: [row.sessionID, row.messageID] }),
    index("raya_result_notice_root_idx").on(row.sessionID, row.userID),
    uniqueIndex("raya_result_notice_original_idx").on(row.jobID, row.revision, row.callID, row.inputID),
    check(
      "raya_result_notice_bounds",
      sql`length(CAST(${row.body} AS BLOB)) BETWEEN 1 AND 262144 AND length(${row.sha}) = 64 AND length(CAST(${row.sessionID} AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(${row.messageID} AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(${row.userID} AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(${row.jobID} AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(${row.revision} AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(${row.callID} AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(${row.inputID} AS BLOB)) BETWEEN 1 AND 256`,
    ),
  ],
)
