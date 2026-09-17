import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const RayaContactDestinationTable = sqliteTable(
  "raya_contact_destination",
  {
    id: text().primaryKey(),
    source: text().notNull(),
    channel: text({ enum: ["raya", "email", "telegram", "whatsapp"] }).notNull(),
    address: text().notNull(),
    label: text(),
    scope: text({ enum: ["global", "agent", "organization"] }).notNull(),
    scope_id: text().notNull(),
    quiet_start: integer(),
    quiet_end: integer(),
    timezone: text(),
    revision: integer().notNull(),
    enabled: integer({ mode: "boolean" }).notNull(),
    revoked_at: integer(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("raya_contact_destination_source").on(table.source),
    uniqueIndex("raya_contact_destination_identity").on(table.channel, table.address, table.scope, table.scope_id),
    index("raya_contact_destination_scope").on(table.scope, table.scope_id, table.enabled),
  ],
)

export const RayaContactMessageTable = sqliteTable(
  "raya_contact_message",
  {
    id: text().primaryKey(),
    source: text().notNull(),
    destination_id: text()
      .notNull()
      .references(() => RayaContactDestinationTable.id),
    destination_revision: integer().notNull(),
    agent_id: text(),
    organization_id: text(),
    session_id: text(),
    body: text().notNull(),
    state: text({ enum: ["queued", "leased", "retry", "delivered", "failed", "cancelled"] }).notNull(),
    attempts: integer().notNull(),
    available_at: integer().notNull(),
    lease_id: text(),
    lease_owner: text(),
    lease_until: integer(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("raya_contact_message_source").on(table.source),
    index("raya_contact_message_pending").on(table.state, table.available_at, table.time_created),
    index("raya_contact_message_destination").on(table.destination_id, table.state, table.time_created),
  ],
)

export const RayaContactReceiptTable = sqliteTable("raya_contact_receipt", {
  message_id: text()
    .primaryKey()
    .references(() => RayaContactMessageTable.id, { onDelete: "cascade" }),
  status: text({ enum: ["delivered", "failed", "cancelled"] }).notNull(),
  code: text({
    enum: ["delivered", "authorization-revoked", "delivery-failed", "delivery-unknown", "retry-exhausted"],
  }).notNull(),
  provider_ref: text(),
  attempts: integer().notNull(),
  time_created: integer().notNull(),
})
