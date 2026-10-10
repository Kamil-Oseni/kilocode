import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { createHash } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineOccurrenceTable as Occurrence } from "@opencode-ai/core/kilocode/routine.sql"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { removals } from "@/kilocode/task/removal"
import { scheduler } from "@/kilocode/task/scheduler"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const key = ["raya", "queue-cleanup-cursor"]
const state = (dir: string) =>
  Layer.mergeAll(
    Storage.layerFromDir(path.join(dir, "storage")),
    Database.layerFromPath(path.join(dir, "queue.sqlite")),
  )
const publish = (queue: ReturnType<typeof RayaTaskQueue.make>, id: string, count: number, version = 1) =>
  Effect.gen(function* () {
    for (let offset = 0; offset < count; offset += 256) {
      const size = Math.min(256, count - offset)
      yield* queue.publish({
        agentID: id,
        version,
        ...(offset ? { expected: offset } : {}),
        occurrences: Array.from({ length: size }, (_, index) => ({ at: offset + index + 1, observedAt: count })),
      })
    }
  })
const count = (database: Database.Interface, id?: string) =>
  database.db
    .select({ count: sql<number>`count(*)` })
    .from(Occurrence)
    .where(and(eq(Occurrence.state, "queued"), id ? eq(Occurrence.agent_id, id) : undefined))
    .get()
    .pipe(Effect.map((row) => row!.count))

it.live("first-use cleanup leaves an absent roster and housekeeping cursor absent across cold reopening", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    for (let attempt = 0; attempt < 2; attempt++)
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        expect(yield* RayaTask.make(input).list()).toEqual([])
        yield* scheduler(input).clean()
        expect(yield* RayaTask.make(input).list()).toEqual([])
        expect(Exit.isFailure(yield* input.storage.readBounded(key, 1024).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* input.storage.readBounded(["raya", "agent"], 1024).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(yield* input.storage.readBounded(["raya", "agent-initialized"], 1024).pipe(Effect.exit)),
        ).toBe(true)
        expect(yield* count(input.database)).toBe(0)
      }).pipe(Effect.provide(state(dir)))
  }),
)

it.live("cleanup refuses a missing roster with initialization, original queue, or removal evidence", () =>
  Effect.gen(function* () {
    for (const kind of ["initialized", "queued", "removal"]) {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        if (kind === "initialized") {
          yield* RayaTask.make(input).create({ name: "Original", objective: "Work", schedule: { kind: "manual" } })
          yield* input.storage.remove(["raya", "agent"])
        }
        if (kind === "queued") yield* publish(RayaTaskQueue.make(input.database), "original", 1)
        if (kind === "removal") yield* removals(input.storage).stage("original")
        const result = yield* scheduler(input).clean().pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("saved worker list is missing")
        expect(Exit.isFailure(yield* input.storage.readBounded(key, 1024).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* input.storage.readBounded(["raya", "agent"], 1024).pipe(Effect.exit))).toBe(true)
        expect(yield* count(input.database)).toBe(kind === "queued" ? 1 : 0)
        if (kind === "removal") expect(yield* removals(input.storage).pending()).toHaveLength(1)
      }).pipe(Effect.provide(state(dir)))
    }
  }),
)

it.live(
  "bounded old-version retirement preserves active rows and exact cursor across reopening",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const retained = yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const queue = RayaTaskQueue.make(database)
        yield* publish(queue, "routine", 2052)
        yield* publish(queue, "routine", 2, 2)
        yield* publish(queue, "routine", 2, 3)
        yield* publish(queue, "foreign", 2)
        const rows = yield* queue.pending("routine", 1)
        yield* queue.claim({ id: rows[0].id, claimID: "original", owner: "owner", now: 3000, until: 4000 })
        yield* queue.claim({ id: rows[1].id, claimID: "linked", owner: "owner", now: 3000, until: 4000 })
        yield* queue.link({ id: rows[1].id, claimID: "linked", sessionID: "session", now: 3001 })
        const active = yield* queue.active("routine")
        const cursor = yield* queue.cursor("routine", 1)
        expect(yield* queue.retire("routine", 2)).toEqual({ removed: 1024, complete: false })
        expect(yield* count(database, "routine")).toBe(1030)
        return { active, cursor }
      }).pipe(Effect.provide(state(dir)))
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const queue = RayaTaskQueue.make(database)
        expect(yield* queue.retire("routine", 2)).toEqual({ removed: 1024, complete: false })
        expect(yield* queue.retire("routine", 2)).toEqual({ removed: 2, complete: true })
        expect(yield* queue.active("routine")).toEqual(retained.active)
        expect(yield* queue.cursor("routine", 1)).toEqual(retained.cursor)
        expect(yield* queue.pending("routine", 2)).toHaveLength(2)
        expect(yield* queue.pending("routine", 3)).toHaveLength(2)
        expect(yield* queue.pending("foreign", 1)).toHaveLength(2)
        expect(yield* queue.retire("routine", 2)).toEqual({ removed: 0, complete: true })
        const plan = yield* database.db.all<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT id FROM raya_routine_occurrence WHERE agent_id='routine' AND state='queued' AND schedule_version<2 ORDER BY schedule_version,scheduled_at,id LIMIT 1024",
        )
        expect(plan.map((row) => row.detail).join(" ")).toContain("COVERING INDEX raya_routine_occurrence_cleanup")
        expect(plan.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE")
      }).pipe(Effect.provide(state(dir)))
    }),
  30000,
)

it.live(
  "one poll shares retirement and removal budget and blocks new-version startup until cold completion",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const saved = yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const tasks = RayaTask.make(input)
        const at = Date.now() + 60000
        const item = yield* tasks.create({ name: "Routine", objective: "Work", schedule: { kind: "once", at } })
        const changed = yield* tasks.update(item.id, { schedule: { kind: "once", at: at + 60000 } })
        const queue = RayaTaskQueue.make(input.database)
        yield* publish(queue, item.id, 2050)
        yield* publish(queue, "removed", 2050)
        yield* removals(input.storage).stage("removed")
        const schedule = scheduler(input)
        yield* schedule.clean()
        expect(yield* count(input.database)).toBe(4100 - 1024)
        expect(yield* count(input.database, item.id)).toBe(1538)
        expect(yield* count(input.database, "removed")).toBe(1538)
        expect(yield* count(input.database)).toBe(3076)
        expect(yield* schedule.prepare(item.id, at + 60000)).toBeUndefined()
        expect(yield* removals(input.storage).pending()).toHaveLength(1)
        return { item: changed, at }
      }).pipe(Effect.provide(state(dir)))
      for (let poll = 0; poll < 4; poll++) {
        yield* Effect.gen(function* () {
          const input = { storage: yield* Storage.Service, database: yield* Database.Service }
          const before = yield* count(input.database)
          yield* scheduler(input).clean()
          const after = yield* count(input.database)
          expect(before - after).toBeLessThanOrEqual(1024)
          expect(after).toBeLessThan(before)
        }).pipe(Effect.provide(state(dir)))
      }
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const schedule = scheduler(input)
        expect(yield* count(input.database)).toBe(0)
        expect(yield* removals(input.storage).pending()).toEqual([])
        expect((yield* schedule.prepare(saved.item.id, saved.at + 60000))?.scheduledAt).toBe(saved.at + 60000)
      }).pipe(Effect.provide(state(dir)))
    }),
  30000,
)

it.live(
  "combined identity windows advance both cleanup classes without hiding cold backlogs",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const tasks = RayaTask.make(input)
        const template = yield* tasks.create({ name: "Template", objective: "Work", schedule: { kind: "manual" } })
        const ids = Array.from({ length: 130 }, (_, index) => `old-${index}`)
        yield* input.storage.replace(
          ["raya", "agent"],
          ids.map((id) => ({ ...template, id, scheduleVersion: 2 })),
        )
        yield* input.storage.replace(
          ["raya", "agent-removals"],
          ids.map((_, index) => ({ version: 1, agentID: `removed-${index}`, at: index })),
        )
        const queue = RayaTaskQueue.make(input.database)
        for (const id of ids) yield* publish(queue, id, 5)
        for (let index = 0; index < 130; index++) yield* publish(queue, `removed-${index}`, 5)
        const schedule = scheduler(input)
        yield* schedule.clean()
        expect(yield* count(input.database)).toBe(276)
        expect(yield* count(input.database, "old-129")).toBe(5)
        expect(yield* count(input.database, "removed-129")).toBe(5)
        yield* schedule.clean()
        expect(yield* count(input.database, "old-129")).toBeLessThan(5)
        expect(yield* count(input.database, "removed-129")).toBeLessThan(5)
      }).pipe(Effect.provide(state(dir)))
      for (let poll = 0; poll < 2; poll++)
        yield* Effect.gen(function* () {
          const input = { storage: yield* Storage.Service, database: yield* Database.Service }
          yield* scheduler(input).clean()
        }).pipe(Effect.provide(state(dir)))
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        expect(yield* count(input.database)).toBe(0)
        expect(yield* removals(input.storage).pending()).toEqual([])
      }).pipe(Effect.provide(state(dir)))
    }),
  30000,
)

it.live(
  "cold scan advances beyond 256 empty routines without granting effect authority to its cursor",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const saved = yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const tasks = RayaTask.make(input)
        const template = yield* tasks.create({ name: "Template", objective: "Work", schedule: { kind: "manual" } })
        const ids = Array.from({ length: 300 }, (_, index) => `routine-${index}`)
        yield* input.storage.replace(
          ["raya", "agent"],
          ids.map((id) => ({ ...template, id, scheduleVersion: 2 })),
        )
        const queue = RayaTaskQueue.make(input.database)
        yield* publish(queue, ids[299], 2050)
        const cursor = yield* queue.cursor(ids[299], 1)
        yield* scheduler(input).clean()
        expect(yield* count(input.database)).toBe(2050)
        expect(yield* input.storage.read(key)).toEqual({
          version: 1,
          roster: createHash("sha256").update(ids[255]).digest("hex"),
          removal: null,
        })
        return { id: ids[299], cursor }
      }).pipe(Effect.provide(state(dir)))
      for (const remaining of [1026, 2, 0])
        yield* Effect.gen(function* () {
          const input = { storage: yield* Storage.Service, database: yield* Database.Service }
          yield* scheduler(input).clean()
          expect(yield* count(input.database)).toBe(remaining)
          expect(yield* RayaTaskQueue.make(input.database).cursor(saved.id, 1)).toEqual(saved.cursor)
        }).pipe(Effect.provide(state(dir)))
    }),
  30000,
)

it.live(
  "cursor acknowledgement loss retains queued debt and corrupt or oversized cursors fail before effects",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const id = yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const tasks = RayaTask.make({ storage, database })
        const item = yield* tasks.create({
          name: "Routine",
          objective: "Work",
          schedule: { kind: "once", at: Date.now() + 60000 },
        })
        yield* tasks.update(item.id, { schedule: { kind: "manual" } })
        yield* publish(RayaTaskQueue.make(database), item.id, 2050)
        const wrapped: Storage.Interface = {
          ...storage,
          replace: (parts, value) =>
            storage
              .replace(parts, value)
              .pipe(
                Effect.andThen(
                  parts.join("/") === key.join("/")
                    ? Effect.die(new Error("Applied cursor acknowledgement lost"))
                    : Effect.void,
                ),
              ),
        }
        expect(Exit.isFailure(yield* scheduler({ storage: wrapped, database }).clean().pipe(Effect.exit))).toBe(true)
        expect(yield* count(database)).toBe(1026)
        expect(yield* storage.read(key)).toMatchObject({ version: 1, removal: null })
        return item.id
      }).pipe(Effect.provide(state(dir)))
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        yield* scheduler(input).clean()
        expect(yield* count(input.database)).toBe(2)
        const valid = yield* input.storage.read(key)
        for (const invalid of [
          { version: 2, roster: null, removal: null },
          { version: 1, roster: null, removal: null, extra: true },
          "x".repeat(2048),
        ]) {
          yield* input.storage.replace(key, invalid)
          expect(Exit.isFailure(yield* scheduler(input).clean().pipe(Effect.exit))).toBe(true)
          expect(yield* count(input.database)).toBe(2)
          expect(yield* input.storage.read(key)).toEqual(invalid)
        }
        yield* input.storage.replace(key, valid)
        yield* scheduler(input).clean()
        expect(yield* count(input.database)).toBe(0)
        expect(yield* RayaTaskQueue.make(input.database).obsolete(id, 2)).toBeUndefined()
      }).pipe(Effect.provide(state(dir)))
    }),
  30000,
)
