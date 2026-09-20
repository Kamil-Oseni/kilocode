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
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

const make = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

async function upgrade(version: string, hash: string, seed: (db: SQLite) => void, id: string) {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "kilo.db")
  {
    using source = new SQLite(filename)
    const fixture = await Bun.file(path.join(import.meta.dir, `fixture/v${version}.sql`)).text()
    expect(new Bun.CryptoHasher("sha256").update(fixture).digest("hex")).toBe(hash)
    source.exec(fixture)
    seed(source)
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* make
      yield* DatabaseMigration.apply(db)
      return { ids: (yield* list(db)).map((item) => item.id), content: yield* dump(db, id) }
    }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
  )
}

describe("pre-migration recovery snapshots", () => {
  test("upgrades and restores the exact v7.0.47 workspace schema", async () => {
    const result = await upgrade(
      "7.0.47",
      "b843336078771bfcce28b3167d8e921082c64d6e8a3aa8b0afac4bb9903b94e1",
      () => undefined,
      "20260303231226_add_workspace_fields",
    )
    expect(result.ids[0]).toBe("20260303231226_add_workspace_fields")
    using restored = new SQLite(":memory:")
    restored.exec(result.content)
    expect(restored.query("SELECT name FROM pragma_table_info('workspace') WHERE name='config'").get()).toEqual({
      name: "config",
    })
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  })

  test("leaves a populated v7.0.47 workspace untouched when its historical upgrade cannot run", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "kilo.db")
    {
      using source = new SQLite(filename)
      source.exec(await Bun.file(path.join(import.meta.dir, "fixture/v7.0.47.sql")).text())
      source.exec(`
        INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project','/repo',1,1,'[]');
        INSERT INTO workspace (id,branch,project_id,config) VALUES ('workspace','main','project','{"retained":true}');
      `)
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* make
        yield* DatabaseMigration.apply(db)
      }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped, Effect.result),
    )
    expect(result._tag).toBe("Failure")
    using preserved = new SQLite(filename)
    expect(preserved.query("SELECT config FROM workspace WHERE id='workspace'").get()).toEqual({
      config: '{"retained":true}',
    })
    expect(preserved.query("SELECT id FROM migration WHERE id='20260303231226_add_workspace_fields'").get()).toBeNull()
    expect(preserved.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  })

  test("restores account state from the exact v7.2.3 schema", async () => {
    const result = await upgrade(
      "7.2.3",
      "0cff3cfe3aea4b72b7b6cc3e6f0e6b22f82d5038996df1ec04ca676ccff5396e",
      (db) =>
        db.exec(`
          INSERT INTO control_account (email,url,access_token,refresh_token,active,time_created,time_updated)
            VALUES ('owner@example.com','https://example.com','access','refresh',1,1,2);
        `),
      "20260309230000_move_org_to_state",
    )
    expect(result.ids[0]).toBe("20260309230000_move_org_to_state")
    using restored = new SQLite(":memory:")
    restored.exec(result.content)
    expect(restored.query("SELECT email,access_token,active FROM control_account").get()).toEqual({
      email: "owner@example.com",
      access_token: "access",
      active: 1,
    })
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  })

  test("restores session projections from the exact v7.3.1 schema", async () => {
    const result = await upgrade(
      "7.3.1",
      "fe09a909d1fd5171367848932290e4da6eefbb0e4a7e8efb75b7caaf4de4302b",
      (db) =>
        db.exec(`
          INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project','/repo',1,1,'[]');
          INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated)
            VALUES ('session','project','session','/repo','Retained session','7.3.1',1,2);
          INSERT INTO session_entry (id,session_id,type,time_created,time_updated,data)
            VALUES ('entry','session','message',1,2,'{"retained":true}');
        `),
      "20260427172553_slow_nightmare",
    )
    expect(result.ids[0]).toBe("20260427172553_slow_nightmare")
    using restored = new SQLite(":memory:")
    restored.exec(result.content)
    expect(restored.query("SELECT data FROM session_entry WHERE id='entry'").get()).toEqual({
      data: '{"retained":true}',
    })
    expect(restored.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  })

  test("restores saved permissions from the exact v7.4.7 schema", async () => {
    const result = await upgrade(
      "7.4.7",
      "0aeb51d9b41ce13c0c7568831d41a08e31590ef93c4c078f992c5ac2fbf0bc2c",
      (db) =>
        db.exec(`
          INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project','/repo',1,1,'[]');
          INSERT INTO permission (project_id,time_created,time_updated,data)
            VALUES ('project',1,2,'[{"permission":"read","pattern":"*","action":"allow"}]');
        `),
      "20260601202201_amazing_prowler",
    )
    expect(result.ids.slice(0, 3)).toEqual([
      "20260601202201_amazing_prowler",
      "20260603040000_session_message_projection_order",
      "20260604172448_event_sourced_session_input",
    ])
    using restored = new SQLite(":memory:")
    restored.exec(result.content)
    expect(restored.query("SELECT data FROM permission WHERE project_id='project'").get()).toEqual({
      data: '[{"permission":"read","pattern":"*","action":"allow"}]',
    })
    expect(restored.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  })

  test("upgrades and restores the exact v7.4.15 credential schema", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "kilo.db")
    {
      using source = new SQLite(filename)
      const fixture = await Bun.file(path.join(import.meta.dir, "fixture/v7.4.15.sql")).text()
      expect(new Bun.CryptoHasher("sha256").update(fixture).digest("hex")).toBe(
        "e79163799cc044722c171fe43b0321fa5293e96f1c2fbfb904eb55f339183dab",
      )
      source.exec(fixture)
      source.exec(`
        INSERT INTO credential (id,connector_id,method_id,label,value,active,time_created,time_updated)
          VALUES ('credential','connector','method','Retained credential','encrypted-value',1,1,2);
      `)
    }

    const content = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* make
        yield* DatabaseMigration.apply(db)
        expect(yield* db.all("SELECT id FROM credential")).toEqual([])
        expect((yield* list(db)).map((item) => item.id)).toEqual([
          "20260611192811_lush_chimera",
          "20260622142730_simplify_session_context_epoch",
          "20260622170816_reset_v2_session_state",
          "20260622202450_simplify_session_input",
        ])
        return yield* dump(db, "20260611192811_lush_chimera")
      }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
    )

    using restored = new SQLite(":memory:")
    restored.exec(content)
    expect(restored.query("SELECT * FROM credential").get()).toEqual({
      id: "credential",
      connector_id: "connector",
      method_id: "method",
      label: "Retained credential",
      value: "encrypted-value",
      active: 1,
      time_created: 1,
      time_updated: 2,
    })
    expect(restored.query("SELECT name FROM sqlite_master WHERE name='credential_connector_active_idx'").get()).toEqual(
      {
        name: "credential_connector_active_idx",
      },
    )
    expect(restored.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  })

  test("upgrades and restores the exact v7.4.20 release schema", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "kilo.db")
    {
      using source = new SQLite(filename)
      const fixture = await Bun.file(path.join(import.meta.dir, "fixture/v7.4.20.sql")).text()
      expect(new Bun.CryptoHasher("sha256").update(fixture).digest("hex")).toBe(
        "7f5f6daaf3da3d301e9869b2ec26ab656340eddf271560d3edfeb1522dcd1c88",
      )
      source.exec(fixture)
      source.exec(`
        INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project','/repo',1,1,'[]');
        INSERT INTO workspace (id,type,name,project_id,time_used) VALUES ('workspace','local','Workspace','project',1);
        INSERT INTO session (id,project_id,workspace_id,slug,directory,title,version,time_created,time_updated)
          VALUES ('session','project','workspace','session','/repo','Retained session','7.4.20',1,1);
        INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('message','session',1,1,'{"role":"user"}');
        INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
          VALUES ('part','message','session',1,1,'{"type":"text","text":"Retain canonical history"}');
        INSERT INTO session_context_epoch (session_id,baseline,agent,snapshot,baseline_seq,replacement_seq,revision)
          VALUES ('session','baseline','build','snapshot',1,2,3);
        INSERT INTO session_input (id,session_id,prompt,delivery,admitted_seq,promoted_seq,time_created)
          VALUES ('input','session','Retain input','promoted',1,2,1);
        INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data)
          VALUES ('projection','session','user',1,1,1,'{"text":"Retain projection"}');
        INSERT INTO event_sequence (aggregate_id,seq,owner_id) VALUES ('session',1,'owner');
        INSERT INTO event (id,aggregate_id,seq,type,data) VALUES ('event','session',1,'session.updated','{"saved":true}');
      `)
    }

    const content = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* make
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get("SELECT workspace_id FROM session WHERE id = 'session'")).toEqual({ workspace_id: null })
        expect(yield* db.get("SELECT id FROM message WHERE id = 'message'")).toEqual({ id: "message" })
        expect(yield* db.get("SELECT id FROM part WHERE id = 'part'")).toEqual({ id: "part" })
        expect(yield* db.all("SELECT id FROM session_message")).toEqual([])
        expect(yield* db.all("SELECT id FROM event")).toEqual([])
        expect((yield* list(db)).map((item) => item.id)).toEqual([
          "20260622142730_simplify_session_context_epoch",
          "20260622170816_reset_v2_session_state",
          "20260622202450_simplify_session_input",
        ])
        return yield* dump(db, "20260622142730_simplify_session_context_epoch")
      }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
    )

    using restored = new SQLite(":memory:")
    restored.exec(content)
    expect(restored.query("SELECT workspace_id FROM session WHERE id = 'session'").get()).toEqual({
      workspace_id: "workspace",
    })
    expect(restored.query("SELECT data FROM message WHERE id = 'message'").get()).toEqual({ data: '{"role":"user"}' })
    expect(restored.query("SELECT data FROM part WHERE id = 'part'").get()).toEqual({
      data: '{"type":"text","text":"Retain canonical history"}',
    })
    expect(restored.query("SELECT prompt FROM session_input WHERE id = 'input'").get()).toEqual({
      prompt: "Retain input",
    })
    expect(restored.query("SELECT data FROM session_message WHERE id = 'projection'").get()).toEqual({
      data: '{"text":"Retain projection"}',
    })
    expect(restored.query("SELECT data FROM event WHERE id = 'event'").get()).toEqual({ data: '{"saved":true}' })
    expect(restored.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  })

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
