import { index, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"

export const RayaVoiceBindingTable = sqliteTable(
  "raya_voice_binding",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [index("raya_voice_binding_session_idx").on(table.session_id)],
)
