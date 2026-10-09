import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { removals } from "@/kilocode/task/removal"
import { claim } from "@/kilocode/task/claim"
import { scheduler } from "@/kilocode/task/scheduler"
import { inspect } from "@/kilocode/task/recovery"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const key = ["raya", "agent-removals"]
const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ version: 1 as const, agentID: `pending-${index}`, at: index }))
const state = (directory: string) =>
  Layer.mergeAll(
    Storage.layerFromDir(path.join(directory, "storage")),
    Database.layerFromPath(path.join(directory, "queue.sqlite")),
  )
const bytes = (directory: string) =>
  Effect.promise(() => Bun.file(path.join(directory, "storage/raya/agent-removals.json")).text())

it.live("a full removal backlog preserves exact retries and order across actual storage reopening", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const original = rows(1024)
    const before = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.replace(key, original)
      yield* removals(storage).stage(original[0].agentID)
      const held = yield* bytes(directory)
      const failed = yield* removals(storage).stage("new-removal").pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      if (Exit.isFailure(failed)) expect(Cause.pretty(failed.cause)).toContain("full at 1024")
      expect(yield* bytes(directory)).toBe(held)
      return held
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const receipts = removals(storage)
      expect(yield* receipts.pending()).toEqual(original)
      yield* receipts.check(original[1023].agentID)
      yield* receipts.stage(original[1023].agentID)
      expect(yield* bytes(directory)).toBe(before)
      yield* receipts.finish([original[0].agentID])
      yield* receipts.stage("new-removal")
      const retained = yield* receipts.pending()
      expect(retained.slice(0, -1)).toEqual(original.slice(1))
      expect(retained.at(-1)?.agentID).toBe("new-removal")
      expect(retained).toHaveLength(1024)
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("capacity refusal leaves the actual roster and queue unchanged and clears the read-only startup claim", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const saved = yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const tasks = RayaTask.make(input)
      const agent = yield* tasks.create({ name: "Retain routine", objective: "Work", schedule: { kind: "manual" } })
      const queue = RayaTaskQueue.make(input.database)
      yield* queue.publish({ agentID: agent.id, version: 1, occurrences: [{ at: 1000, observedAt: 1000 }] })
      yield* input.storage.replace(key, rows(1024))
      const before = yield* bytes(directory)
      const roster = yield* input.storage.read(["raya", "agent"])
      const queued = yield* queue.pending(agent.id, 1)
      const failed = yield* tasks.remove(agent.id).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      if (Exit.isFailure(failed)) expect(Cause.pretty(failed.cause)).toContain("full at 1024")
      expect(yield* input.storage.read(["raya", "agent"])).toEqual(roster)
      expect(yield* queue.pending(agent.id, 1)).toEqual(queued)
      expect(yield* bytes(directory)).toBe(before)
      expect(yield* inspect(input.storage, agent.id)).toBeUndefined()
      expect((yield* tasks.page()).items).toEqual([])
      return { id: agent.id, queued, roster, before }
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const queue = RayaTaskQueue.make(yield* Database.Service)
      expect(yield* storage.read(["raya", "agent"])).toEqual(saved.roster)
      expect(yield* queue.pending(saved.id, 1)).toEqual(saved.queued)
      expect(yield* bytes(directory)).toBe(saved.before)
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("a failed late stage retains the original claim instead of reporting clean removal", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const receipts = removals(storage)
      yield* storage.replace(key, rows(1023))
      const failed = yield* claim(
        storage,
        "owned-removal",
        receipts.check("owned-removal"),
        () => storage.replace(key, rows(1024)).pipe(Effect.andThen(receipts.stage("owned-removal"))),
        undefined,
        "remove",
      ).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      const held = yield* storage.read<{ agentID: string; operation: string }>([
        "raya",
        "agent-claims",
        createHash("sha256").update("owned-removal").digest("hex"),
      ])
      expect(held.agentID).toBe("owned-removal")
      expect(held.operation).toBe("remove")
      expect(yield* receipts.pending()).toEqual(rows(1024))
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      expect((yield* inspect(storage, "owned-removal"))?.state).toBe("recovery")
      expect(yield* removals(storage).pending()).toEqual(rows(1024))
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("oversized legacy evidence and oversized UTF-8 identities fail closed without rewriting originals", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const receipts = removals(storage)
      const database = yield* Database.Service
      const queue = RayaTaskQueue.make(database)
      yield* queue.publish({ agentID: "pending-0", version: 1, occurrences: [{ at: 1000, observedAt: 1000 }] })
      const queued = yield* queue.pending("pending-0", 1)
      yield* receipts.stage("😀".repeat(64))
      const accepted = yield* bytes(directory)
      expect(Exit.isFailure(yield* receipts.stage("😀".repeat(65)).pipe(Effect.exit))).toBe(true)
      expect(yield* bytes(directory)).toBe(accepted)
      for (const original of [rows(1025), [{ version: 1, agentID: "x".repeat(257), at: 1 }]]) {
        yield* storage.replace(key, original)
        const held = yield* bytes(directory)
        for (const action of [receipts.pending(), receipts.stage("new"), receipts.finish(["pending-0"])]) {
          const failed = yield* action.pipe(Effect.exit)
          expect(Exit.isFailure(failed)).toBe(true)
          if (Exit.isFailure(failed)) expect(Cause.pretty(failed.cause)).toContain("Review it before changing routines")
          expect(yield* bytes(directory)).toBe(held)
        }
        const cleanup = yield* scheduler({ storage, database }).clean().pipe(Effect.exit)
        expect(Exit.isFailure(cleanup)).toBe(true)
        if (Exit.isFailure(cleanup)) expect(Cause.pretty(cleanup.cause)).toContain("RayaTask.GuardError")
        expect(yield* queue.pending("pending-0", 1)).toEqual(queued)
        expect(yield* bytes(directory)).toBe(held)
      }
    }).pipe(Effect.provide(state(directory)))
  }),
)
