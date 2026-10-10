import { sql } from "drizzle-orm"
import { check, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

/** Original admissions survive unknown death as debt; no row grants execution. */
export const BackgroundOutcome = sqliteTable(
  "raya_background_outcome",
  {
    id: text().notNull(),
    revision: text().notNull(),
    identity: text().notNull(),
    identitySHA: text("identity_sha").notNull(),
    phase: text({ enum: ["admitted", "terminal", "joined"] }).notNull(),
    terminal: text(),
    terminalSHA: text("terminal_sha"),
  },
  (row) => [
    primaryKey({ columns: [row.id, row.revision] }),
    check(
      "raya_background_outcome_bounds",
      sql`length(CAST(${row.id} AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(${row.revision} AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(${row.identity} AS BLOB)) BETWEEN 1 AND 262144 AND length(${row.identitySHA}) = 64 AND ${row.phase} IN ('admitted','terminal','joined') AND ((${row.phase} = 'admitted' AND ${row.terminal} IS NULL AND ${row.terminalSHA} IS NULL) OR (${row.phase} IN ('terminal','joined') AND ${row.terminal} IS NOT NULL AND ${row.terminalSHA} IS NOT NULL AND length(CAST(${row.terminal} AS BLOB)) BETWEEN 1 AND 262144 AND length(${row.terminalSHA}) = 64))`,
    ),
  ],
)
