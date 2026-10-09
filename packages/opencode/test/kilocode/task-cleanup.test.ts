import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
import { PtyArchive } from "@/kilocode/pty/archive"
import { removals } from "@/kilocode/task/removal"
import { scheduler } from "@/kilocode/task/scheduler"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const key = ["raya", "agent-removals"]
const state = (dir: string) =>
  Layer.mergeAll(
    Storage.layerFromDir(path.join(dir, "storage")),
    Database.layerFromPath(path.join(dir, "queue.sqlite")),
  )
const publish = (queue: ReturnType<typeof RayaTaskQueue.make>, agentID: string, count: number, version = 1) =>
  Effect.gen(function* () {
    for (let offset = 0; offset < count; offset += 256) {
      const size = Math.min(256, count - offset)
      yield* queue.publish({
        agentID,
        version,
        ...(offset ? { expected: offset } : {}),
        occurrences: Array.from({ length: size }, (_, index) => ({ at: offset + index + 1, observedAt: count })),
      })
    }
  })
const count = (database: Database.Interface) =>
  database.db
    .get<{ count: number }>("SELECT COUNT(*) AS count FROM raya_routine_occurrence WHERE state='queued'")
    .pipe(Effect.map((row) => row!.count))

it.live(
  "organization archive retains its stop receipt until bounded queue cleanup finishes after reopening",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const layer = () =>
        Layer.merge(
          Storage.layerFromDir(path.join(dir, "storage")),
          LayerNode.compile(LayerNode.group([Database.node, PtyArchive.node]), [
            [Database.node, Database.layerFromPath(path.join(dir, "queue.sqlite"))],
          ]),
        )
      const sessions = {
        create: () => Effect.die("Unexpected model session creation"),
        get: () => Effect.die("Unexpected model session lookup"),
        messages: () => Effect.die("Unexpected model session messages"),
        children: () => Effect.die("Unexpected model session children"),
      }
      const saved = yield* Effect.gen(function* () {
        const input = {
          storage: yield* Storage.Service,
          database: yield* Database.Service,
          pty: yield* PtyArchive.Service,
          sessions,
          halt: () => Effect.die("Unexpected live session cancellation"),
        }
        const runner = RayaTaskRunner.make(input)
        const worker = yield* runner.tasks.create({
          name: "Scheduled",
          objective: "Work",
          schedule: { kind: "once", at: Date.now() + 60000 },
        })
        const queue = RayaTaskQueue.make(input.database)
        yield* publish(queue, worker.id, 2050)
        const organizations = RayaTaskOrganization.make(
          input.database,
          { ...runner.tasks, stop: runner.stopMembers },
          input.storage,
        )
        const item = yield* organizations.create({ name: "Team", members: [{ agentID: worker.id, role: "Worker" }] })
        expect(Exit.isFailure(yield* organizations.archive(item.id, { expectedRevision: 1 }).pipe(Effect.exit))).toBe(
          true,
        )
        expect(yield* count(input.database)).toBe(1026)
        expect((yield* organizations.get(item.id)).archived).toBe(false)
        expect((yield* organizations.pending()).map((row) => row.id)).toEqual([item.id])
        expect((yield* runner.tasks.get(worker.id)).enabled).toBe(false)
        expect((yield* queue.cursor(worker.id, 1))?.through).toBe(2050)
        return { id: item.id, worker: worker.id }
      }).pipe(Effect.provide(layer()))
      yield* Effect.gen(function* () {
        const input = {
          storage: yield* Storage.Service,
          database: yield* Database.Service,
          pty: yield* PtyArchive.Service,
          sessions,
          halt: () => Effect.die("Unexpected replay of stopped session"),
        }
        const runner = RayaTaskRunner.make(input)
        const organizations = RayaTaskOrganization.make(
          input.database,
          { ...runner.tasks, stop: runner.stopMembers },
          input.storage,
        )
        expect(Exit.isFailure(yield* runner.recoverStops().pipe(Effect.exit))).toBe(true)
        expect(yield* count(input.database)).toBe(2)
        expect((yield* organizations.get(saved.id)).archived).toBe(false)
        yield* runner.recoverStops()
        expect(yield* count(input.database)).toBe(0)
        expect((yield* organizations.get(saved.id)).archived).toBe(true)
        expect(yield* organizations.pending()).toEqual([])
        expect(yield* runner.tasks.runsFor(saved.worker)).toEqual([])
        expect((yield* RayaTaskQueue.make(input.database).cursor(saved.worker, 1))?.through).toBe(2050)
      }).pipe(Effect.provide(layer()))
    }),
  30000,
)

it.live("existing database reopening applies the additive cleanup index and uses it without a history scan", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const queue = RayaTaskQueue.make(database)
      yield* publish(queue, "removed", 5)
      yield* database.db.run("DROP INDEX raya_routine_occurrence_cleanup")
      yield* database.db.run("DELETE FROM migration WHERE id='20261009233719_kilocode-routine-cleanup'")
      expect(
        yield* database.db.get("SELECT name FROM sqlite_master WHERE name='raya_routine_occurrence_cleanup'"),
      ).toBeUndefined()
    }).pipe(Effect.provide(state(dir)))
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      expect(yield* count(database)).toBe(5)
      expect(
        yield* database.db.get("SELECT id FROM migration WHERE id='20261009233719_kilocode-routine-cleanup'"),
      ).toBeDefined()
      const plan = yield* database.db.all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT id FROM raya_routine_occurrence WHERE agent_id='removed' AND state='queued' ORDER BY schedule_version,scheduled_at,id LIMIT 1024",
      )
      expect(plan.some((row) => row.detail.includes("raya_routine_occurrence_cleanup"))).toBe(true)
      expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false)
    }).pipe(Effect.provide(state(dir)))
  }),
)

it.live(
  "one removed routine drains at most 1024 rows per poll across reopening without changing active work or cursors",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const saved = yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const queue = RayaTaskQueue.make(input.database)
        yield* input.storage.replace(["raya", "agent"], [])
        yield* publish(queue, "removed/Ω", 2051)
        yield* publish(queue, "unrelated", 3)
        const rows = yield* queue.pending("removed/Ω", 1)
        yield* queue.claim({ id: rows[0].id, claimID: "starting", owner: "original", now: 3000, until: 4000 })
        yield* queue.claim({ id: rows[1].id, claimID: "linked", owner: "original", now: 3000, until: 4000 })
        yield* queue.link({ id: rows[1].id, claimID: "linked", sessionID: "session", now: 3001 })
        yield* removals(input.storage).stage("removed/Ω")
        const active = yield* queue.active("removed/Ω")
        const cursor = yield* queue.cursor("removed/Ω", 1)
        yield* scheduler(input).clean()
        expect(yield* count(input.database)).toBe(1028)
        expect(yield* removals(input.storage).pending()).toHaveLength(1)
        expect(yield* queue.active("removed/Ω")).toEqual(active)
        return { active, cursor }
      }).pipe(Effect.provide(state(dir)))
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const queue = RayaTaskQueue.make(input.database)
        const clean = scheduler(input)
        yield* clean.clean()
        expect(yield* count(input.database)).toBe(4)
        expect(yield* removals(input.storage).pending()).toHaveLength(1)
        yield* clean.clean()
        expect(yield* count(input.database)).toBe(3)
        expect(yield* removals(input.storage).pending()).toEqual([])
        expect(yield* queue.active("removed/Ω")).toEqual(saved.active)
        expect(yield* queue.cursor("removed/Ω", 1)).toEqual(saved.cursor)
        expect(yield* queue.pending("unrelated", 1)).toHaveLength(3)
      }).pipe(Effect.provide(state(dir)))
    }),
)

it.live(
  "many removed IDs share one row budget and successive windows do not starve later receipts",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const queue = RayaTaskQueue.make(input.database)
        yield* input.storage.replace(["raya", "agent"], [])
        const ids = Array.from({ length: 300 }, (_, index) => `removed-${index}`)
        for (const id of ids) yield* publish(queue, id, 5)
        yield* input.storage.replace(
          key,
          ids.map((agentID, index) => ({ version: 1, agentID, at: index })),
        )
        const clean = scheduler(input)
        yield* clean.clean()
        expect(yield* count(input.database)).toBe(476)
        expect(yield* removals(input.storage).pending()).toHaveLength(300)
        expect(yield* queue.pending(ids[256], 1)).toHaveLength(5)
        yield* clean.clean()
        expect(yield* count(input.database)).toBe(88)
        expect(yield* queue.pending(ids[256], 1)).toHaveLength(1)
        expect(yield* removals(input.storage).pending()).toHaveLength(88)
        yield* clean.clean()
        expect(yield* count(input.database)).toBe(0)
        expect(yield* removals(input.storage).pending()).toEqual([])
      }).pipe(Effect.provide(state(dir)))
    }),
  30000,
)

it.live("acknowledgement loss keeps exact removal evidence until all SQL batches are durably exhausted", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const held = yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const queue = RayaTaskQueue.make(input.database)
      yield* input.storage.replace(["raya", "agent"], [])
      yield* publish(queue, "removed", 1025)
      yield* removals(input.storage).stage("removed")
      const original = yield* input.storage.read(key)
      const broken = scheduler({
        ...input,
        storage: {
          ...input.storage,
          replace: (parts, value) =>
            parts.join("/") === "raya/agent-removals"
              ? Effect.die(new Error("Original receipt acknowledgement lost"))
              : input.storage.replace(parts, value),
        },
      })
      yield* broken.clean()
      expect(yield* count(input.database)).toBe(1)
      expect(yield* input.storage.read(key)).toEqual(original)
      expect(Exit.isFailure(yield* broken.clean().pipe(Effect.exit))).toBe(true)
      expect(yield* count(input.database)).toBe(0)
      expect(yield* input.storage.read(key)).toEqual(original)
      return original
    }).pipe(Effect.provide(state(dir)))
    yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      expect(yield* input.storage.read(key)).toEqual(held)
      yield* scheduler(input).clean()
      expect(yield* removals(input.storage).pending()).toEqual([])
      expect(yield* count(input.database)).toBe(0)
    }).pipe(Effect.provide(state(dir)))
  }),
)

it.live("missing or invalid roster and invalid batch bounds preserve original queued rows and receipt bytes", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const queue = RayaTaskQueue.make(input.database)
      yield* publish(queue, "removed", 5)
      yield* removals(input.storage).stage("removed")
      const held = yield* Effect.promise(() => Bun.file(path.join(dir, "storage/raya/agent-removals.json")).text())
      for (const value of [undefined, {}, [{ id: "invalid" }]]) {
        if (value !== undefined) yield* input.storage.replace(["raya", "agent"], value)
        const result = yield* scheduler(input).clean().pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toBeTruthy()
        expect(yield* count(input.database)).toBe(5)
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "storage/raya/agent-removals.json")).text())).toBe(
          held,
        )
      }
      for (const limit of [0, 1025, 1.5])
        expect(Exit.isFailure(yield* queue.discard("removed", undefined, limit).pipe(Effect.exit))).toBe(true)
      expect(yield* count(input.database)).toBe(5)
      const plan = yield* input.database.db.all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT id FROM raya_routine_occurrence WHERE agent_id='removed' AND state='queued' ORDER BY schedule_version,scheduled_at,id LIMIT 1024",
      )
      expect(plan.some((row) => row.detail.includes("raya_routine_occurrence_cleanup"))).toBe(true)
      expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false)
    }).pipe(Effect.provide(state(dir)))
  }),
)
