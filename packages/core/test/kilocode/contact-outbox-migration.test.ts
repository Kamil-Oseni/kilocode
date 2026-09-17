import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import migration from "@opencode-ai/core/database/migration/20260917035533_kilocode-contact-outbox"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

test("contact migration creates the durable authorization, outbox, and receipt tables", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === migration.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* DatabaseMigration.applyOnly(db, [migration])
      yield* db.run(
        sql`INSERT INTO raya_contact_destination (id, source, channel, address, scope, scope_id, revision, enabled, time_created, time_updated) VALUES ('ctd_test', 'source', 'raya', 'owner', 'global', '', 1, 1, 1, 1)`,
      )
      yield* db.run(
        sql`INSERT INTO raya_contact_message (id, source, destination_id, destination_revision, body, state, attempts, available_at, time_created, time_updated) VALUES ('ctm_test', 'message', 'ctd_test', 1, 'Ready', 'delivered', 1, 1, 1, 1)`,
      )
      yield* db.run(
        sql`INSERT INTO raya_contact_receipt (message_id, status, code, attempts, time_created) VALUES ('ctm_test', 'delivered', 'delivered', 1, 2)`,
      )
      yield* DatabaseMigration.applyOnly(db, [migration])
      expect(yield* db.get(sql`SELECT code FROM raya_contact_receipt WHERE message_id = 'ctm_test'`)).toEqual({
        code: "delivered",
      })
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${migration.id}`)).toEqual({
        count: 1,
      })
    }),
  )
})

test("a conflicting contact table rolls back the entire migration", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE raya_contact_message (id TEXT PRIMARY KEY)`)
      yield* db.run(sql`INSERT INTO raya_contact_message (id) VALUES ('preserve')`)
      expect(Exit.isFailure(yield* DatabaseMigration.applyOnly(db, [migration]).pipe(Effect.exit))).toBe(true)
      expect(yield* db.get(sql`SELECT id FROM raya_contact_message`)).toEqual({ id: "preserve" })
      expect(
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'raya_contact_destination'`),
      ).toBeUndefined()
      expect(
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'raya_contact_receipt'`),
      ).toBeUndefined()
      expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${migration.id}`)).toBeUndefined()
    }),
  )
})
