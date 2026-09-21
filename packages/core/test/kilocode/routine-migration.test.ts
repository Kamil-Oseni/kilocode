import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import migration from "@opencode-ai/core/database/migration/20260908092112_kilocode-routine-occurrence"
import archive from "@opencode-ai/core/database/migration/20260908124554_kilocode-routine-archive"
import attachments from "@opencode-ai/core/database/migration/20260912150000_kilocode-routine-user-attachments"
import organization from "@opencode-ai/core/database/migration/20260912210000_kilocode-routine-organization"
import delegation from "@opencode-ai/core/database/migration/20260912231306_kilocode-routine-organization-delegation"
import policy from "@opencode-ai/core/database/migration/20260915143138_kilocode-routine-organization-policy"
import draft from "@opencode-ai/core/database/migration/20260916221534_kilocode-routine-draft-revision"
import budget from "@opencode-ai/core/database/migration/20260917021944_kilocode-routine-organization-budget"
import artifacts from "@opencode-ai/core/database/migration/20260921060802_kilocode-routine-delegation-artifacts"
import reservations from "@opencode-ai/core/database/migration/20260921084500_kilocode-routine-organization-reservation"
import coordinator from "@opencode-ai/core/database/migration/20260921093000_kilocode-routine-organization-coordinator"
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

test("attachment schema upgrade preserves drafts and marks legacy attached user messages delivered", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === attachments.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* db.run(
        sql`INSERT INTO raya_routine_conversation (id, agent_id, read_at, draft, time_updated) VALUES ('conversation', 'books', 0, 'keep me', 10)`,
      )
      yield* db.run(
        sql`INSERT INTO raya_routine_message (id, agent_id, source, kind, body, session_id, time_created) VALUES ('legacy', 'books', 'user_old', 'user', 'old question', 'ses_old', 12)`,
      )
      yield* DatabaseMigration.applyOnly(db, [attachments])
      expect(
        yield* db.get(sql`SELECT draft, draft_attachments FROM raya_routine_conversation WHERE agent_id = 'books'`),
      ).toEqual({ draft: "keep me", draft_attachments: null })
      expect(
        yield* db.get(sql`SELECT attachments, delivery_id, delivered_at FROM raya_routine_message WHERE id = 'legacy'`),
      ).toEqual({ attachments: null, delivery_id: null, delivered_at: 12 })
      expect(
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'raya_routine_attachment'`),
      ).toEqual({
        name: "raya_routine_attachment",
      })
      yield* DatabaseMigration.applyOnly(db, [attachments])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${attachments.id}`)).toEqual({
        count: 1,
      })
    }),
  )
})

test("a conflicting attachment table rolls back its added message and conversation columns", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === attachments.id)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* db.run(sql`CREATE TABLE raya_routine_attachment (id TEXT PRIMARY KEY)`)
      expect(Exit.isFailure(yield* DatabaseMigration.applyOnly(db, [attachments]).pipe(Effect.exit))).toBe(true)
      const conversation = yield* db.all<{ name: string }>(sql`PRAGMA table_info('raya_routine_conversation')`)
      const message = yield* db.all<{ name: string }>(sql`PRAGMA table_info('raya_routine_message')`)
      expect(conversation.some((column) => column.name === "draft_attachments")).toBe(false)
      expect(message.some((column) => column.name === "attachments")).toBe(false)
      expect(message.some((column) => column.name === "delivery_id")).toBe(false)
      expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${attachments.id}`)).toBeUndefined()
    }),
  )
})

test("organization migration creates durable graph and immutable revision tables idempotently", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === organization.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* DatabaseMigration.applyOnly(db, [organization])
      yield* db.run(
        sql`INSERT INTO raya_routine_organization (id, name, revision, time_created, time_updated) VALUES ('org_test', 'Test', 1, 1, 1)`,
      )
      yield* db.run(
        sql`INSERT INTO raya_routine_organization_member (organization_id, agent_id, role, position, time_created, time_updated) VALUES ('org_test', 'worker', 'Owner', 0, 1, 1)`,
      )
      yield* db.run(
        sql`INSERT INTO raya_routine_organization_revision (organization_id, revision, definition, time_created) VALUES ('org_test', 1, '{"version":1}', 1)`,
      )
      yield* DatabaseMigration.applyOnly(db, [organization])
      expect(yield* db.get(sql`SELECT role, position FROM raya_routine_organization_member`)).toEqual({
        role: "Owner",
        position: 0,
      })
      expect(yield* db.get(sql`SELECT definition FROM raya_routine_organization_revision`)).toEqual({
        definition: '{"version":1}',
      })
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${organization.id}`)).toEqual({
        count: 1,
      })
    }),
  )
})

test("a conflicting organization member table rolls back the organization migration", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE raya_routine_organization_member (id TEXT PRIMARY KEY)`)
      expect(Exit.isFailure(yield* DatabaseMigration.applyOnly(db, [organization]).pipe(Effect.exit))).toBe(true)
      expect(
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'raya_routine_organization'`),
      ).toBeUndefined()
      expect(
        yield* db.get(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'raya_routine_organization_revision'`,
        ),
      ).toBeUndefined()
      expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${organization.id}`)).toBeUndefined()
    }),
  )
})

test("organization delegation migration preserves queued work and adds directional edges", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === delegation.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* db.run(
        sql`INSERT INTO raya_routine_organization (id, name, revision, time_created, time_updated) VALUES ('org_test', 'Test', 1, 1, 1)`,
      )
      yield* db.run(
        sql`INSERT INTO raya_routine_delegation (id, source, sender_id, recipient_id, objective, depth, state, time_created, time_updated) VALUES ('request', 'source', 'chief', 'books', 'Review', 1, 'queued', 1, 1)`,
      )
      yield* DatabaseMigration.applyOnly(db, [delegation])
      expect(
        yield* db.get(sql`SELECT state, organization_id FROM raya_routine_delegation WHERE id = 'request'`),
      ).toEqual({
        state: "queued",
        organization_id: null,
      })
      yield* db.run(
        sql`INSERT INTO raya_routine_organization_delegation (organization_id, sender_id, recipient_id, position, time_created, time_updated) VALUES ('org_test', 'chief', 'books', 0, 1, 1)`,
      )
      expect(yield* db.get(sql`SELECT sender_id, recipient_id FROM raya_routine_organization_delegation`)).toEqual({
        sender_id: "chief",
        recipient_id: "books",
      })
      yield* DatabaseMigration.applyOnly(db, [delegation])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${delegation.id}`)).toEqual({
        count: 1,
      })
    }),
  )
})

test("organization policy migration preserves existing organizations with no inferred policy", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === policy.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* db.run(
        sql`INSERT INTO raya_routine_organization (id, name, purpose, revision, time_created, time_updated) VALUES ('org_test', 'Test', 'Keep purpose', 1, 1, 1)`,
      )
      yield* DatabaseMigration.applyOnly(db, [policy])
      expect(
        yield* db.get(sql`SELECT name, purpose, policy, revision FROM raya_routine_organization WHERE id = 'org_test'`),
      ).toEqual({ name: "Test", purpose: "Keep purpose", policy: null, revision: 1 })
      yield* db.run(sql`UPDATE raya_routine_organization SET policy = 'Keep evidence exact' WHERE id = 'org_test'`)
      expect(yield* db.get(sql`SELECT policy FROM raya_routine_organization WHERE id = 'org_test'`)).toEqual({
        policy: "Keep evidence exact",
      })
      yield* DatabaseMigration.applyOnly(db, [policy])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${policy.id}`)).toEqual({ count: 1 })
    }),
  )
})

test("organization budget migration preserves existing organizations with no inferred limit", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === budget.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* db.run(
        sql`INSERT INTO raya_routine_organization (id, name, purpose, policy, revision, time_created, time_updated) VALUES ('org_budget', 'Budget', 'Keep purpose', 'Keep policy', 2, 1, 2)`,
      )
      yield* DatabaseMigration.applyOnly(db, [budget])
      expect(
        yield* db.get(
          sql`SELECT name, purpose, policy, budget, revision FROM raya_routine_organization WHERE id = 'org_budget'`,
        ),
      ).toEqual({ name: "Budget", purpose: "Keep purpose", policy: "Keep policy", budget: null, revision: 2 })
      yield* db.run(sql`UPDATE raya_routine_organization SET budget = 250 WHERE id = 'org_budget'`)
      expect(yield* db.get(sql`SELECT budget FROM raya_routine_organization WHERE id = 'org_budget'`)).toEqual({
        budget: 250,
      })
      yield* DatabaseMigration.applyOnly(db, [budget])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${budget.id}`)).toEqual({ count: 1 })
    }),
  )
})

test("draft revision migration preserves existing routine drafts and starts them at revision zero", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === draft.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* db.run(
        sql`INSERT INTO raya_routine_conversation (id, agent_id, read_at, draft, draft_attachments, time_updated) VALUES ('conversation', 'books', 0, 'keep this', '[{"id":"file","name":"ledger.txt","mime":"text/plain","size":6}]', 10)`,
      )
      yield* DatabaseMigration.applyOnly(db, [draft])
      expect(
        yield* db.get(
          sql`SELECT draft, draft_attachments, draft_revision FROM raya_routine_conversation WHERE agent_id = 'books'`,
        ),
      ).toEqual({
        draft: "keep this",
        draft_attachments: '[{"id":"file","name":"ledger.txt","mime":"text/plain","size":6}]',
        draft_revision: 0,
      })
      yield* DatabaseMigration.applyOnly(db, [draft])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${draft.id}`)).toEqual({ count: 1 })
    }),
  )
})

test("delegation artifact migration preserves queued work and adds verified handoffs", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === artifacts.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* db.run(
        sql`INSERT INTO raya_routine_delegation (id, source, sender_id, recipient_id, objective, depth, state, time_created, time_updated) VALUES ('request', 'source', 'design', 'frontend', 'Build the approved design', 1, 'queued', 1, 1)`,
      )
      yield* DatabaseMigration.applyOnly(db, [artifacts])
      expect(yield* db.get(sql`SELECT state, artifacts FROM raya_routine_delegation WHERE id = 'request'`)).toEqual({
        state: "queued",
        artifacts: null,
      })
      const saved = JSON.stringify([{ path: "/approved.fig", sha256: "d".repeat(64), tool: "write", callID: "call" }])
      yield* db.run(sql`UPDATE raya_routine_delegation SET artifacts = ${saved} WHERE id = 'request'`)
      expect(yield* db.get(sql`SELECT artifacts FROM raya_routine_delegation WHERE id = 'request'`)).toEqual({
        artifacts: saved,
      })
      yield* DatabaseMigration.applyOnly(db, [artifacts])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${artifacts.id}`)).toEqual({
        count: 1,
      })
    }),
  )
})

test("organization reservation migration preserves organizations and enforces exact session ownership", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === reservations.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* db.run(
        sql`INSERT INTO raya_routine_organization (id, name, purpose, policy, budget, revision, time_created, time_updated) VALUES ('org_reservation', 'Reservation', NULL, NULL, 20, 3, 1, 1)`,
      )
      yield* DatabaseMigration.applyOnly(db, [reservations])
      yield* db.run(
        sql`INSERT INTO raya_routine_organization_reservation (run_id, agent_id, organization_id, organization_revision, session_id, budget, cost, state, time_created, time_updated) VALUES ('run_one', 'worker', 'org_reservation', 3, 'session_one', 5, NULL, 'linked', 1, 1)`,
      )
      const duplicate = yield* db
        .run(
          sql`INSERT INTO raya_routine_organization_reservation (run_id, agent_id, organization_id, organization_revision, session_id, budget, cost, state, time_created, time_updated) VALUES ('run_two', 'worker', 'org_reservation', 3, 'session_one', 5, NULL, 'linked', 1, 1)`,
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(duplicate)).toBe(true)
      expect(
        yield* db.get(sql`SELECT name, budget, revision FROM raya_routine_organization WHERE id = 'org_reservation'`),
      ).toEqual({
        name: "Reservation",
        budget: 20,
        revision: 3,
      })
      yield* DatabaseMigration.applyOnly(db, [reservations])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${reservations.id}`)).toEqual({
        count: 1,
      })
    }),
  )
})

test("organization coordinator migration preserves organizations and stores ambiguous message ownership", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const index = migrations.findIndex((item) => item.id === coordinator.id)
      expect(index).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index))
      yield* db.run(
        sql`INSERT INTO raya_routine_organization (id, name, purpose, policy, budget, revision, time_created, time_updated) VALUES ('org_coordinator', 'Coordinator', NULL, NULL, 20, 3, 1, 1)`,
      )
      yield* DatabaseMigration.applyOnly(db, [coordinator])
      yield* db.run(
        sql`INSERT INTO raya_routine_organization_coordinator (message_id, session_id, organization_id, organization_revision, state, time_created, time_updated) VALUES ('message_one', 'session_one', 'org_coordinator', 3, 'attributed', 1, 1)`,
      )
      yield* db.run(
        sql`UPDATE raya_routine_organization_coordinator SET organization_id = NULL, organization_revision = NULL, state = 'ambiguous' WHERE message_id = 'message_one'`,
      )
      expect(
        yield* db.get(
          sql`SELECT organization_id, organization_revision, state FROM raya_routine_organization_coordinator WHERE message_id = 'message_one'`,
        ),
      ).toEqual({ organization_id: null, organization_revision: null, state: "ambiguous" })
      expect(
        yield* db.get(sql`SELECT name, revision FROM raya_routine_organization WHERE id = 'org_coordinator'`),
      ).toEqual({
        name: "Coordinator",
        revision: 3,
      })
      yield* DatabaseMigration.applyOnly(db, [coordinator])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${coordinator.id}`)).toEqual({
        count: 1,
      })
    }),
  )
})
