import { expect } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineConversationTable as Conversation,
  RayaRoutineOrganizationTable as Organization,
  RayaRoutineOrganizationMemberTable as Member,
} from "@opencode-ai/core/kilocode/routine.sql"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { RayaTask } from "@/kilocode/task"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const input = { name: "Saved worker", objective: "Keep my work", schedule: { kind: "manual" as const } }

const refused = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("Expected missing roster refusal")
  expect(Cause.pretty(exit.cause)).toContain("Restore the worker list from a backup")
}

it.live("missing initialized roster refuses list and creation after reopening, then accepts exact restoration", () =>
  Effect.gen(function* () {
    const dir = path.join(yield* tmpdirScoped(), "storage")
    const saved = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const tasks = RayaTask.make({ storage })
      expect(yield* tasks.list()).toEqual([])
      const worker = yield* tasks.create(input)
      const saved = yield* tasks.list()
      yield* storage.remove(["raya", "agent"])
      return { worker, saved }
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const tasks = RayaTask.make({ storage })
      refused(yield* tasks.list().pipe(Effect.exit))
      expect(Exit.isFailure(yield* tasks.create(input).pipe(Effect.exit))).toBe(true)
      expect(yield* storage.read(["raya", "agent"]).pipe(Effect.flip)).toBeInstanceOf(Storage.NotFoundError)
      yield* storage.replace(["raya", "agent"], saved.saved)
      expect(yield* tasks.get(saved.worker.id)).toEqual(saved.worker)
      expect((yield* tasks.create({ ...input, name: "New worker" })).id).not.toBe(saved.worker.id)
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)

it.live("legacy SQLite worker evidence prevents replacing a lost roster and preserves organization stop fences", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const filename = path.join(dir, "profile.sqlite")
    const storage = path.join(dir, "storage")
    const saved = yield* Effect.gen(function* () {
      const store = yield* Storage.Service
      const database = yield* Database.Service
      const tasks = RayaTask.make({ storage: store, database })
      const worker = yield* tasks.create(input)
      yield* database.db
        .insert(Organization)
        .values({
          id: "team",
          name: "Retained team",
          revision: 1,
          archived_at: 200,
          stopping_at: 200,
          stopped_at: 201,
          time_created: 100,
          time_updated: 201,
        })
        .run()
      yield* database.db
        .insert(Member)
        .values({
          organization_id: "team",
          agent_id: worker.id,
          role: "researcher",
          position: 0,
          time_created: 100,
          time_updated: 100,
        })
        .run()
      yield* database.db
        .insert(Conversation)
        .values({
          agent_id: worker.id,
          id: "saved-inbox",
          read_at: 0,
          draft: "Keep this draft",
          time_updated: 100,
        })
        .run()
      const saved = yield* tasks.list()
      yield* store.remove(["raya", "agent-initialized"])
      yield* store.remove(["raya", "agent"])
      return { worker, saved }
    }).pipe(Effect.provide(Storage.layerFromDir(storage)), Effect.provide(Database.layerFromPath(filename)))
    yield* Effect.gen(function* () {
      const store = yield* Storage.Service
      const database = yield* Database.Service
      const tasks = RayaTask.make({ storage: store, database })
      const before = yield* database.db.select().from(Organization).all()
      const members = yield* database.db.select().from(Member).all()
      const inbox = yield* database.db.select().from(Conversation).all()
      refused(yield* tasks.list().pipe(Effect.exit))
      refused(yield* tasks.create(input).pipe(Effect.exit))
      expect(yield* store.read(["raya", "agent"]).pipe(Effect.flip)).toBeInstanceOf(Storage.NotFoundError)
      expect(yield* database.db.select().from(Organization).all()).toEqual(before)
      expect(yield* database.db.select().from(Member).all()).toEqual(members)
      expect(yield* database.db.select().from(Conversation).all()).toEqual(inbox)
      yield* store.replace(["raya", "agent"], saved.saved)
      expect(yield* tasks.get(saved.worker.id)).toEqual(saved.worker)
      expect(yield* tasks.ready(Date.now())).toEqual([])
    }).pipe(Effect.provide(Storage.layerFromDir(storage)), Effect.provide(Database.layerFromPath(filename)))
  }),
)

it.live("an empty organization and a staging plan still permit first-worker creation", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      yield* database.db
        .insert(Organization)
        .values({
          id: "new-team",
          name: "New team",
          revision: 1,
          time_created: 100,
          time_updated: 100,
        })
        .run()
      yield* storage.replace(["raya", "agent-stage", "planned"], { plan: "Not a saved worker" })
      const tasks = RayaTask.make({ storage, database })
      expect(yield* tasks.list()).toEqual([])
      expect((yield* tasks.create(input)).name).toBe(input.name)
    }).pipe(
      Effect.provide(Storage.layerFromDir(path.join(dir, "storage"))),
      Effect.provide(Database.layerFromPath(path.join(dir, "profile.sqlite"))),
    )
  }),
)

it.live("legacy retained run files protect a missing roster without a database or new marker", () =>
  Effect.gen(function* () {
    const dir = path.join(yield* tmpdirScoped(), "storage")
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const tasks = RayaTask.make({ storage })
      yield* storage.replace(["raya", "agent-runs", "legacy"], [{ id: "retained" }])
      refused(yield* tasks.list().pipe(Effect.exit))
      refused(yield* tasks.create(input).pipe(Effect.exit))
      expect(yield* storage.read(["raya", "agent-runs", "legacy"])).toEqual([{ id: "retained" }])
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)
