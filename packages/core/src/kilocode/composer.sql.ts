import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/** Cleared identities remain durable members of the CAS namespace. */
export const RayaComposerTable = sqliteTable(
  "raya_composer_draft",
  {
    sequence: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull(),
    workspace: text().notNull(),
    project: text().notNull(),
    box: text().notNull(),
    record: text().notNull(),
    content_bytes: integer().notNull(),
    metadata_bytes: integer().notNull(),
  },
  (table) => [
    uniqueIndex("raya_composer_identity").on(table.id),
    index("raya_composer_catalog").on(table.workspace, table.project, table.box, table.sequence),
  ],
)

/** Exact private source evidence joins the separately committed JSON and SQL stores. */
export const RayaComposerControlTable = sqliteTable("raya_composer_control", {
  id: text().primaryKey(),
  storage: text().notNull(),
  database: text().notNull(),
  generation: text().notNull(),
  phase: text().notNull(),
  source: text(),
  source_digest: text().notNull(),
  marker: text(),
  marker_digest: text().notNull(),
  cursor_secret: text().notNull(),
  content_bytes: integer().notNull(),
  metadata_bytes: integer().notNull(),
})
