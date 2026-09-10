import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import migration from "@opencode-ai/core/database/migration/20260910044904_kilocode-voice-binding"
import { RayaVoiceBindingTable } from "@opencode-ai/core/kilocode/voice.sql"

const data = {
  binding: { id: "voice", parentSessionID: "parent" },
  calls: { work: { status: "completed", messageID: "message" } },
  images: { image: { data: "bounded-image" } },
  usage: [{ kind: "transcription", seconds: 2.75 }],
}

function parents(db: EffectDrizzleSqlite.EffectSQLiteDatabase) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', '/repo', 1, 1, '[]')`,
    )
    for (const id of ["parent", "other"])
      yield* db.run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${id}, 'project', ${id}, '/repo', ${id}, '7.4.23', 1, 1)`,
      )
  })
}

function ownership(db: EffectDrizzleSqlite.EffectSQLiteDatabase) {
  return Effect.gen(function* () {
    yield* db.insert(RayaVoiceBindingTable).values({ id: "voice", session_id: "parent", data }).run()
    yield* db
      .insert(RayaVoiceBindingTable)
      .values({ id: "other-voice", session_id: "other", data: { keep: true } })
      .run()
    expect(yield* db.select().from(RayaVoiceBindingTable).where(eq(RayaVoiceBindingTable.id, "voice")).get()).toEqual({
      id: "voice",
      session_id: "parent",
      data,
    })
    yield* DatabaseMigration.apply(db)
    expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${migration.id}`)).toEqual({ count: 1 })
    expect(yield* db.get(sql`SELECT count(*) AS count FROM raya_voice_binding`)).toEqual({ count: 2 })
    yield* db.run(sql`DELETE FROM session WHERE id = 'parent'`)
    expect(yield* db.select().from(RayaVoiceBindingTable)).toEqual([
      { id: "other-voice", session_id: "other", data: { keep: true } },
    ])
    expect(yield* db.all(sql`SELECT id, title FROM session`)).toEqual([{ id: "other", title: "other" }])
    expect(yield* db.get(sql`SELECT id FROM project`)).toEqual({ id: "project" })
    const stale = yield* db
      .insert(RayaVoiceBindingTable)
      .values({ id: "late", session_id: "parent", data })
      .run()
      .pipe(Effect.exit)
    expect(Exit.isFailure(stale)).toBe(true)
    expect(yield* db.get(sql`SELECT id FROM raya_voice_binding WHERE id = 'late'`)).toBeUndefined()
    const moved = yield* db
      .update(RayaVoiceBindingTable)
      .set({ session_id: "missing" })
      .where(eq(RayaVoiceBindingTable.id, "other-voice"))
      .run()
      .pipe(Effect.exit)
    expect(Exit.isFailure(moved)).toBe(true)
    expect(yield* db.get(sql`SELECT session_id FROM raya_voice_binding WHERE id = 'other-voice'`)).toEqual({
      session_id: "other",
    })
    expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })
}

test("fresh production core database enforces voice ownership, cascades only the deleted parent, and rejects late writes", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      expect(yield* db.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
      expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE name = 'raya_voice_binding_session_idx'`)).toEqual({
        name: "raya_voice_binding_session_idx",
      })
      yield* parents(db)
      yield* ownership(db)
      for (const statement of [
        sql`INSERT INTO raya_voice_binding (id, session_id, data) VALUES ('null-parent', NULL, '{}')`,
        sql`INSERT INTO raya_voice_binding (id, session_id, data) VALUES ('null-data', 'other', NULL)`,
      ])
        expect(Exit.isFailure(yield* db.run(statement).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("upgrades the previous core schema additively and reapplies idempotently with the same foreign-key guarantees", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`PRAGMA foreign_keys = ON`)
      const index = migrations.findIndex((entry) => entry.id === migration.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* parents(db)
      const before = yield* db.all(sql`SELECT * FROM session ORDER BY id`)
      expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE name = 'raya_voice_binding'`)).toBeUndefined()
      yield* DatabaseMigration.apply(db)
      expect(yield* db.all(sql`SELECT * FROM session ORDER BY id`)).toEqual(before)
      expect(yield* db.all(sql`SELECT * FROM raya_voice_binding`)).toEqual([])
      yield* ownership(db)
      yield* DatabaseMigration.apply(db)
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${migration.id}`)).toEqual({
        count: 1,
      })
      expect(yield* db.select().from(RayaVoiceBindingTable)).toEqual([
        { id: "other-voice", session_id: "other", data: { keep: true } },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})
