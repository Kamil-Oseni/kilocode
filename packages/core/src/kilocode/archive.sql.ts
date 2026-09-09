import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { desc } from "drizzle-orm"

export const RayaRoutineArchiveTable = sqliteTable(
  "raya_routine_archive",
  {
    id: text().primaryKey(),
    archived_at: integer().notNull(),
    definition: text().notNull(),
  },
  (table) => [index("raya_routine_archive_order").on(desc(table.archived_at), table.id)],
)

export const RayaRoutineArchiveImportTable = sqliteTable("raya_routine_archive_import", {
  id: text().primaryKey(),
  time_completed: integer().notNull(),
})
