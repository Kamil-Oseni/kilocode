import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { dump, list } from "@opencode-ai/core/kilocode/migration-backup"
import reset from "@opencode-ai/core/database/migration/20260622170816_reset_v2_session_state"
import { migrations } from "@opencode-ai/core/database/migration.gen"

const make = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

describe("pre-migration recovery snapshots", () => {
  test("restores the actual reset's pre-upgrade data, schema, links and journal", async () => {
    const content = await run(
      Effect.gen(function* () {
        const db = yield* make
        yield* db.run("CREATE TABLE workspace(id TEXT PRIMARY KEY)")
        yield* db.run("CREATE TABLE session(id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspace(id))")
        for (const name of ["session_context_epoch", "session_input", "session_message", "event", "event_sequence"])
          yield* db.run(`CREATE TABLE ${name}(id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id), data TEXT)`)
        yield* db.run("INSERT INTO workspace VALUES ('wrk')")
        yield* db.run("INSERT INTO session VALUES ('ses','wrk')")
        for (const name of ["session_context_epoch", "session_input", "session_message", "event", "event_sequence"])
          yield* db.run(`INSERT INTO ${name} VALUES ('original','ses','preserve me')`)
        yield* db.run("CREATE INDEX message_session ON session_message(session_id)")
        yield* DatabaseMigration.applyOnly(db, [reset])
        expect(yield* db.all("SELECT * FROM session_message")).toEqual([])
        expect(yield* db.get("SELECT workspace_id FROM session")).toEqual({ workspace_id: null })
        expect((yield* list(db)).map((item) => item.id)).toEqual([reset.id])
        yield* DatabaseMigration.applyOnly(db, [reset])
        expect(yield* list(db)).toHaveLength(1)
        return yield* dump(db, reset.id)
      }),
    )
    using restored = new SQLite(":memory:")
    restored.exec(content)
    for (const name of ["session_context_epoch", "session_input", "session_message", "event", "event_sequence"])
      expect(restored.query(`SELECT * FROM ${name}`).all()).toEqual([
        { id: "original", session_id: "ses", data: "preserve me" },
      ])
    expect(restored.query("SELECT workspace_id FROM session").get()).toEqual({ workspace_id: "wrk" })
    expect(restored.query("SELECT * FROM migration").all()).toEqual([])
    expect(restored.query("SELECT name FROM sqlite_master WHERE name='message_session'").get()).toEqual({
      name: "message_session",
    })
    expect(restored.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  })

  test("preserves exact SQLite values, rowids, generated columns and sequences", async () => {
    const content = await run(
      Effect.gen(function* () {
        const db = yield* make
        yield* db.run(
          "CREATE TABLE sample(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, bytes BLOB, wide INTEGER, value REAL, derived TEXT GENERATED ALWAYS AS (text || 'suffix') STORED)",
        )
        yield* db.run(
          "INSERT INTO sample(id,text,bytes,wide,value) VALUES(41,CAST(X'61006227' AS TEXT),X'00FF',9223372036854775807,1.25)",
        )
        yield* db.run("INSERT INTO sample(id) VALUES(99)")
        yield* db.run("DELETE FROM sample WHERE id=99")
        yield* db.run("CREATE TABLE plain(value TEXT)")
        yield* db.run("INSERT INTO plain(rowid,value) VALUES(73,'row')")
        yield* db.run("CREATE TABLE keyed(id TEXT PRIMARY KEY, data BLOB) WITHOUT ROWID")
        yield* db.run("INSERT INTO keyed VALUES('key',X'1234')")
        yield* DatabaseMigration.applyOnly(db, [
          { id: reset.id, up: (tx) => tx.run("DELETE FROM sample").pipe(Effect.asVoid) },
        ])
        return yield* dump(db, reset.id)
      }),
    )
    using restored = new SQLite(":memory:")
    restored.exec(content)
    expect(
      restored
        .query(
          "SELECT id,hex(text) AS text,hex(bytes) AS bytes,CAST(wide AS TEXT) AS wide,value,hex(derived) AS derived FROM sample",
        )
        .get(),
    ).toEqual({
      id: 41,
      text: "61006227",
      bytes: "00FF",
      wide: "9223372036854775807",
      value: 1.25,
      derived: "61006227737566666978",
    })
    restored.exec("INSERT INTO sample(text) VALUES('new')")
    expect(restored.query("SELECT max(id) AS id FROM sample").get()).toEqual({ id: 100 })
    expect(restored.query("SELECT rowid FROM plain").get()).toEqual({ rowid: 73 })
    expect(restored.query("SELECT hex(data) AS data FROM keyed").get()).toEqual({ data: "1234" })
  })

  test("rolls snapshot and journal back when a migration fails, then safely retries", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* make
        yield* db.run("CREATE TABLE sample(id TEXT)")
        yield* db.run("INSERT INTO sample VALUES('kept')")
        const failed = yield* DatabaseMigration.applyOnly(db, [
          {
            id: reset.id,
            up: (tx) => tx.run("DELETE FROM sample").pipe(Effect.andThen(Effect.fail(new Error("interrupted")))),
          },
        ]).pipe(Effect.result)
        expect(failed._tag).toBe("Failure")
        expect(yield* list(db)).toEqual([])
        expect(yield* db.all("SELECT * FROM sample")).toEqual([{ id: "kept" }])
        expect(yield* db.all("SELECT * FROM migration")).toEqual([])
        yield* DatabaseMigration.applyOnly(db, [
          { id: reset.id, up: (tx) => tx.run("DELETE FROM sample").pipe(Effect.asVoid) },
        ])
        expect(yield* list(db)).toHaveLength(1)
        expect(yield* dump(db, reset.id)).toContain("6B657074")
      }),
    )
  })

  test("does not create archives for a fresh current database or an ordinary migration", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* make
        yield* DatabaseMigration.apply(db)
        expect(yield* list(db)).toEqual([])
        expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual({ count: migrations.length })
        yield* DatabaseMigration.applyOnly(db, [
          { id: "safe", up: (tx) => tx.run("CREATE TABLE extra(id TEXT)").pipe(Effect.asVoid) },
        ])
        expect(yield* list(db)).toEqual([])
      }),
    )
  })

  test("stops before destructive work when snapshot storage fails", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* make
        yield* db.run("CREATE TABLE sample(id TEXT)")
        yield* db.run("INSERT INTO sample VALUES('kept')")
        yield* db.run("CREATE TABLE kilo_migration_backup(id TEXT PRIMARY KEY,time_created INTEGER NOT NULL)")
        yield* db.run(
          "CREATE TABLE kilo_migration_backup_statement(seq INTEGER PRIMARY KEY,backup_id TEXT,statement TEXT CHECK(length(statement)=0))",
        )
        const failed = yield* DatabaseMigration.applyOnly(db, [
          { id: reset.id, up: (tx) => tx.run("DELETE FROM sample").pipe(Effect.asVoid) },
        ]).pipe(Effect.result)
        expect(failed._tag).toBe("Failure")
        expect(yield* db.all("SELECT * FROM sample")).toEqual([{ id: "kept" }])
        expect(yield* list(db)).toEqual([])
        expect(yield* db.all("SELECT * FROM migration")).toEqual([])
      }),
    )
  })

  test("restores the full registered schema before a historical reset", async () => {
    const content = await run(
      Effect.gen(function* () {
        const db = yield* make
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`DELETE FROM migration WHERE id = ${reset.id}`)
        yield* db.run("CREATE TABLE canary(id TEXT PRIMARY KEY, data TEXT)")
        yield* db.run("INSERT INTO canary VALUES('record','original')")
        yield* db.run("CREATE TABLE retired(id INTEGER PRIMARY KEY AUTOINCREMENT)")
        yield* db.run("DROP TABLE retired")
        yield* DatabaseMigration.apply(db)
        return yield* dump(db, reset.id)
      }),
    )
    using restored = new SQLite(":memory:")
    restored.exec(content)
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    expect(restored.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(restored.query("SELECT * FROM canary").get()).toEqual({ id: "record", data: "original" })
    expect(restored.query("SELECT count(*) AS count FROM migration").get()).toEqual({ count: migrations.length - 1 })
    expect(restored.query("SELECT name FROM sqlite_master WHERE name LIKE 'kilo_migration_backup%'").all()).toEqual([])
  })
})
