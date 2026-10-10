import { expect } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineArchiveTable as Archive } from "@opencode-ai/core/kilocode/archive.sql"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { RayaTask } from "@/kilocode/task"
import { archive } from "@/kilocode/task/archive"
import * as capacity from "@/kilocode/task/capacity"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const state = (dir: string) =>
  Layer.mergeAll(
    Storage.layerFromDir(path.join(dir, "storage")),
    Database.layerFromPath(path.join(dir, "archive.sqlite")),
  )
const failed = <A, E>(exit: Exit.Exit<A, E>, message?: string) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit) && message) expect(Cause.pretty(exit.cause)).toContain(message)
}

it.live("roster exact byte boundary survives reopening and oversized writes preserve original evidence", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const saved = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const tasks = RayaTask.make({ storage })
      const worker = yield* tasks.create({ name: "Saved", objective: "", schedule: { kind: "manual" } })
      const rows = [{ ...worker, objective: "x".repeat(capacity.roster - Buffer.byteLength(JSON.stringify([worker]))) }]
      expect(capacity.check(rows, capacity.roster, "Roster")).toBe(capacity.roster)
      yield* storage.replace(["raya", "agent"], rows)
      expect(yield* tasks.list()).toEqual(rows)
      const original = yield* Effect.promise(() => Bun.file(path.join(dir, "storage/raya/agent.json")).text())
      failed(yield* tasks.update(worker.id, { objective: rows[0].objective + "x" }).pipe(Effect.exit), "byte capacity")
      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "storage/raya/agent.json")).text())).toBe(original)
      return rows
    }).pipe(Effect.provide(state(dir)))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      expect(yield* RayaTask.make({ storage }).list()).toEqual(saved)
    }).pipe(Effect.provide(state(dir)))
  }),
)

it.live("oversized, invalid UTF-8 and malformed roster bytes refuse without replacing files", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const tasks = RayaTask.make({ storage })
      yield* tasks.create({ name: "Saved", objective: "Retain", schedule: { kind: "manual" } })
      const target = path.join(dir, "storage/raya/agent.json")
      for (const bytes of [
        Buffer.from("[]" + " ".repeat(capacity.roster - 1)),
        Buffer.from([0x5b, 0xff, 0x5d]),
        Buffer.from("["),
      ]) {
        yield* Effect.promise(() => Bun.write(target, bytes))
        failed(yield* tasks.list().pipe(Effect.exit))
        failed(
          yield* tasks.create({ name: "New", objective: "Refuse", schedule: { kind: "manual" } }).pipe(Effect.exit),
        )
        expect(Buffer.from(yield* Effect.promise(() => Bun.file(target).arrayBuffer()))).toEqual(bytes)
      }
    }).pipe(Effect.provide(state(dir)))
  }),
)

it.live("legacy archive and initialized-marker overflow preserve missing-roster refusal and import evidence", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const tasks = RayaTask.make({ storage, database: yield* Database.Service })
      yield* storage.replace(["raya", "agent-archive"], [])
      const target = path.join(dir, "storage/raya/agent-archive.json")
      yield* Effect.promise(() => Bun.write(target, "[]" + " ".repeat(capacity.legacy - 2)))
      expect(yield* tasks.list()).toEqual([])
      yield* Effect.promise(() => Bun.write(target, "[]" + " ".repeat(capacity.legacy - 1)))
      failed(yield* tasks.list().pipe(Effect.exit), "byte capacity")
      failed(yield* tasks.page().pipe(Effect.exit), "byte capacity")
      expect(yield* archive(yield* Database.Service).ready()).toBe(false)
      expect(yield* Effect.sync(() => Bun.file(target).size)).toBe(capacity.legacy + 1)
      yield* storage.remove(["raya", "agent-archive"])
      yield* storage.replace(["raya", "agent-initialized"], { version: 1, extra: "x".repeat(65536) })
      failed(yield* tasks.list().pipe(Effect.exit), "byte capacity")
      expect(yield* storage.read(["raya", "agent"]).pipe(Effect.flip)).toBeInstanceOf(Storage.NotFoundError)
    }).pipe(Effect.provide(state(dir)))
  }),
)

it.live("indexed archive byte pages preserve cursor continuation and refuse oversized retained rows and writes", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const store = archive(database)
      for (const id of ["first", "second", "third"]) {
        yield* store.put({
          id,
          archived_at: 1,
          definition: JSON.stringify({ id, objective: "x".repeat(6 * 1024 * 1024) }),
        })
      }
      const first = yield* store.page({ excluded: [] })
      expect(first.items.map((item) => item.id)).toEqual(["first", "second"])
      expect(first.next).toBe("second")
      const next = yield* store.page({ excluded: [], cursor: first.next })
      expect(next.items.map((item) => item.id)).toEqual(["third"])
      expect(next.next).toBeUndefined()
      const base = JSON.stringify({ id: "boundary", objective: "" })
      const exact = JSON.stringify({
        id: "boundary",
        objective: "x".repeat(capacity.definition - Buffer.byteLength(base)),
      })
      yield* store.put({ id: "boundary", archived_at: 0, definition: exact })
      expect((yield* store.page({ excluded: [], agentID: "boundary" })).items[0].definition).toBe(exact)
      const overflow = JSON.stringify({
        id: "boundary",
        objective: "x".repeat(capacity.definition - Buffer.byteLength(base) + 1),
      })
      failed(yield* store.put({ id: "boundary", archived_at: 3, definition: overflow }).pipe(Effect.exit), "16 MiB")
      expect((yield* store.get("boundary"))?.definition).toBe(exact)
      const definition = JSON.stringify({ id: "huge", objective: "x".repeat(capacity.definition) })
      failed(yield* store.put({ id: "huge", archived_at: 2, definition }).pipe(Effect.exit), "16 MiB")
      expect(yield* store.used("huge")).toBe(false)
      yield* database.db.insert(Archive).values({ id: "huge", archived_at: 2, definition }).run()
      failed(yield* store.page({ excluded: [], agentID: "huge" }).pipe(Effect.exit), "16 MiB")
      failed(yield* store.page({ excluded: [] }).pipe(Effect.exit), "16 MiB")
      expect(yield* store.used("huge")).toBe(true)
    }).pipe(Effect.provide(state(dir)))
  }),
)

it.live("incremental compact JSON measurement retains escapes and Unicode exactly", () =>
  Effect.sync(() => {
    for (const value of [
      [{ id: '\u0000\b\t\n\f\r\\"é😀\ud800', optional: undefined }],
      { nested: [null, true, 4.2, "表"] },
    ]) {
      const bytes = Buffer.byteLength(JSON.stringify(value))
      expect(capacity.check(value, bytes, "Roster")).toBe(bytes)
      expect(() => capacity.check(value, bytes - 1, "Roster")).toThrow("byte capacity")
    }
  }),
)

it.live("corrupt SQL identity text is byte-guarded before metadata allocation without deleting evidence", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const store = archive(database)
      const id = "é".repeat(capacity.definition / 2 + 1)
      yield* database.db.insert(Archive).values({ id, archived_at: 1, definition: "{}" }).run()
      failed(yield* store.page({ excluded: [] }).pipe(Effect.exit), "identity exceeds 16 MiB")
      failed(yield* store.get(id).pipe(Effect.exit), "identity exceeds 16 MiB")
      expect(yield* store.used(id)).toBe(true)
      expect(yield* store.occupied()).toBe(true)
    }).pipe(Effect.provide(state(dir)))
  }),
)
