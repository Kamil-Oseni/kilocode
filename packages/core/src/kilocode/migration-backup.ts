import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { Database } from "../database/database"

type Db = Database.Interface["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

const prefix = "kilo_migration_backup"
const destructive = new Set([
  "20260303231226_add_workspace_fields",
  "20260309230000_move_org_to_state",
  "20260427172553_slow_nightmare",
  "20260601202201_amazing_prowler",
  "20260603040000_session_message_projection_order",
  "20260604172448_event_sourced_session_input",
  "20260611192811_lush_chimera",
  "20260622142730_simplify_session_context_epoch",
  "20260622170816_reset_v2_session_state",
  "20260622202450_simplify_session_input",
])

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

// SQL generates literals inside SQLite, preserving 64-bit integers and embedded NULs
// without round-tripping data through JavaScript numbers or JSON.
const value = (name: string) => {
  const col = identifier(name)
  return `CASE typeof(${col}) WHEN 'text' THEN 'CAST(X''' || hex(${col}) || ''' AS TEXT)' WHEN 'real' THEN replace(replace(quote(${col}), '-Inf', '-9.0e999'), 'Inf', '9.0e999') ELSE quote(${col}) END`
}

/** Called inside the same immediate transaction as the destructive migration. */
export function capture(tx: Tx, id: string) {
  return Effect.gen(function* () {
    if (!destructive.has(id)) return
    const objects = yield* tx.all<{ type: string; name: string; sql: string }>(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    const source = objects.filter((item) => !item.name.startsWith(prefix))
    const tables = source.filter((item) => item.type === "table")
    if (tables.length === 0) return
    if (tables.some((item) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(item.sql)))
      yield* Effect.fail(new Error("Cannot archive virtual tables safely; migration stopped before changing data."))

    yield* tx.run(`CREATE TABLE IF NOT EXISTS ${prefix} (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL)`)
    yield* tx.run(
      `CREATE TABLE IF NOT EXISTS ${prefix}_statement (seq INTEGER PRIMARY KEY, backup_id TEXT NOT NULL, statement TEXT NOT NULL, FOREIGN KEY (backup_id) REFERENCES ${prefix}(id))`,
    )
    yield* tx.run(`CREATE INDEX IF NOT EXISTS ${prefix}_statement_backup ON ${prefix}_statement(backup_id, seq)`)
    if (yield* tx.get(sql`SELECT id FROM kilo_migration_backup WHERE id = ${id}`)) return
    yield* tx.run(sql`INSERT INTO kilo_migration_backup (id, time_created) VALUES (${id}, ${Date.now()})`)
    const append = (statement: string) =>
      tx.run(sql`INSERT INTO kilo_migration_backup_statement (backup_id, statement) VALUES (${id}, ${statement})`)

    for (const table of tables) {
      yield* append(`${table.sql};`)
      const columns = yield* tx.all<{ name: string; hidden: number }>(`PRAGMA table_xinfo(${literal(table.name)})`)
      const names = columns.filter((col) => col.hidden === 0).map((col) => col.name)
      const rowid = /\bWITHOUT\s+ROWID\b/i.test(table.sql)
        ? undefined
        : ["rowid", "_rowid_", "oid"].find((name) => !columns.some((col) => col.name.toLowerCase() === name))
      const fields = rowid ? [rowid, ...names] : names
      const head = `INSERT INTO ${identifier(table.name)} (${fields.map(identifier).join(",")}) VALUES (`
      yield* tx.run(
        `INSERT INTO ${prefix}_statement (backup_id, statement) SELECT ${literal(id)}, ${literal(head)} || ${fields.map(value).join(" || ',' || ")} || ');' FROM ${identifier(table.name)}`,
      )
    }
    if (tables.some((table) => /\bAUTOINCREMENT\b/i.test(table.sql))) {
      yield* append("DELETE FROM sqlite_sequence;")
      yield* tx.run(
        `INSERT INTO ${prefix}_statement (backup_id, statement) SELECT ${literal(id)}, 'INSERT INTO sqlite_sequence(name,seq) VALUES (' || ${value("name")} || ',' || quote(seq) || ');' FROM sqlite_sequence`,
      )
    }
    // Indexes/triggers are restored after data, so triggers cannot replay side effects.
    for (const object of source.filter((item) => item.type !== "table")) yield* append(`${object.sql};`)
  })
}

export function list(db: Db) {
  return Effect.gen(function* () {
    if (!(yield* db.get(sql`SELECT name FROM sqlite_master WHERE name = ${prefix}`))) return []
    return yield* db.all<{ id: string; time_created: number }>(
      "SELECT id, time_created FROM kilo_migration_backup ORDER BY time_created, id",
    )
  })
}

/** Export into a NEW database only; never replay an old schema over a live database. */
export function dump(db: Db, id: string) {
  return Effect.gen(function* () {
    if (!(yield* list(db)).some((item) => item.id === id))
      return yield* Effect.fail(new Error(`Migration backup not found: ${id}`))
    const rows = yield* db.all<{ statement: string }>(
      sql`SELECT statement FROM kilo_migration_backup_statement WHERE backup_id = ${id} ORDER BY seq`,
    )
    return [
      "-- Raya pre-migration recovery snapshot. Restore into an empty database with the matching older application version.",
      "PRAGMA foreign_keys=OFF;",
      "BEGIN IMMEDIATE;",
      ...rows.map((row) => row.statement),
      "COMMIT;",
      "PRAGMA foreign_keys=ON;",
      "PRAGMA integrity_check;",
      "PRAGMA foreign_key_check;",
      "",
    ].join("\n")
  })
}
