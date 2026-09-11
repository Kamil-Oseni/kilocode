import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const RayaRoutineCursorTable = sqliteTable(
  "raya_routine_cursor",
  {
    agent_id: text().notNull(),
    schedule_version: integer().notNull(),
    through: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.agent_id, table.schedule_version] })],
)

export const RayaRoutineOccurrenceTable = sqliteTable(
  "raya_routine_occurrence",
  {
    id: text().primaryKey(),
    agent_id: text().notNull(),
    schedule_version: integer().notNull(),
    scheduled_at: integer().notNull(),
    observed_at: integer().notNull(),
    timezone: text(),
    state: text({ enum: ["queued", "starting", "linked", "complete", "skipped"] }).notNull(),
    claim_id: text(),
    owner: text(),
    lease_until: integer(),
    session_id: text(),
    reason: text(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("raya_routine_occurrence_identity").on(table.agent_id, table.schedule_version, table.scheduled_at),
    index("raya_routine_occurrence_pending").on(
      table.agent_id,
      table.schedule_version,
      table.state,
      table.scheduled_at,
    ),
    index("raya_routine_occurrence_lease").on(table.state, table.lease_until),
  ],
)

export const RayaRoutineConversationTable = sqliteTable("raya_routine_conversation", {
  agent_id: text().primaryKey(),
  id: text().notNull(),
  read_at: integer().notNull(),
  draft: text(),
  time_updated: integer().notNull(),
})

export const RayaRoutineMessageTable = sqliteTable(
  "raya_routine_message",
  {
    id: text().primaryKey(),
    agent_id: text()
      .notNull()
      .references(() => RayaRoutineConversationTable.agent_id, { onDelete: "cascade" }),
    source: text().notNull(),
    kind: text({ enum: ["user", "worker", "report", "decision", "delegation"] }).notNull(),
    body: text().notNull(),
    occurrence_id: text(),
    session_id: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("raya_routine_message_source").on(table.agent_id, table.source),
    index("raya_routine_message_order").on(table.agent_id, table.time_created, table.id),
  ],
)
