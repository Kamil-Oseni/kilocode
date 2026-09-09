import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import migration from "@opencode-ai/core/database/migration/20260908092112_kilocode-routine-occurrence"
import archive from "@opencode-ai/core/database/migration/20260908124554_kilocode-routine-archive"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

test("upgrades the prior schema without changing session data and preserves occurrence uniqueness", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === migration.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* db.run(
        sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', '/repo', 1, 1, '[]')`,
      )
      yield* db.run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session', 'project', 'session', '/repo', 'Keep this session', '7.4.23', 1, 1)`,
      )
      yield* DatabaseMigration.applyOnly(db, [migration])
      expect(yield* db.get(sql`SELECT title FROM session WHERE id = 'session'`)).toEqual({ title: "Keep this session" })
      yield* db.run(
        sql`INSERT INTO raya_routine_occurrence (id, agent_id, schedule_version, scheduled_at, observed_at, state, time_updated) VALUES ('first', 'routine', 1, 1000, 2000, 'queued', 2000)`,
      )
      const duplicate = yield* db
        .run(
          sql`INSERT INTO raya_routine_occurrence (id, agent_id, schedule_version, scheduled_at, observed_at, state, time_updated) VALUES ('different-id', 'routine', 1, 1000, 3000, 'queued', 3000)`,
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(duplicate)).toBe(true)
      yield* DatabaseMigration.applyOnly(db, [migration])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM raya_routine_occurrence`)).toEqual({ count: 1 })
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${migration.id}`)).toEqual({
        count: 1,
      })
    }),
  )
})

test("a failed queue migration rolls back new tables and leaves existing records intact", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE raya_routine_occurrence (id TEXT PRIMARY KEY)`)
      yield* db.run(sql`INSERT INTO raya_routine_occurrence (id) VALUES ('preserve')`)
      const result = yield* DatabaseMigration.applyOnly(db, [migration]).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE name = 'raya_routine_cursor'`)).toBeUndefined()
      expect(yield* db.get(sql`SELECT id FROM raya_routine_occurrence`)).toEqual({ id: "preserve" })
      expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${migration.id}`)).toBeUndefined()
    }),
  )
})

test("archive schema upgrade preserves queued work and reapplication is idempotent", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === archive.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* db.run(
        sql`INSERT INTO raya_routine_occurrence (id, agent_id, schedule_version, scheduled_at, observed_at, state, time_updated) VALUES ('preserved', 'routine', 1, 1000, 1000, 'queued', 1000)`,
      )
      yield* DatabaseMigration.applyOnly(db, [archive])
      expect(yield* db.get(sql`SELECT state FROM raya_routine_occurrence WHERE id = 'preserved'`)).toEqual({
        state: "queued",
      })
      yield* db.run(
        sql`INSERT INTO raya_routine_archive (id, archived_at, definition) VALUES ('routine', 1000, '{"id":"routine"}')`,
      )
      yield* DatabaseMigration.applyOnly(db, [archive])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM raya_routine_archive`)).toEqual({ count: 1 })
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${archive.id}`)).toEqual({ count: 1 })
    }),
  )
})

test("a conflicting archive table rolls back the import-checkpoint table", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE raya_routine_archive (id TEXT PRIMARY KEY)`)
      yield* db.run(sql`INSERT INTO raya_routine_archive (id) VALUES ('preserved')`)
      expect(Exit.isFailure(yield* DatabaseMigration.applyOnly(db, [archive]).pipe(Effect.exit))).toBe(true)
      expect(yield* db.get(sql`SELECT id FROM raya_routine_archive`)).toEqual({ id: "preserved" })
      expect(
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE name = 'raya_routine_archive_import'`),
      ).toBeUndefined()
      expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${archive.id}`)).toBeUndefined()
    }),
  )
})
