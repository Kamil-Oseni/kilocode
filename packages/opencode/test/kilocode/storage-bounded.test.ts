import { expect } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { LimitError, read } from "@/kilocode/storage/bounded-read"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))

it.live("the opened file budget remains exact when the actual file grows after stat", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const target = path.join(dir, "receipt.json")
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(target, "[]")
    const sizes: number[] = []
    const seen: number[] = []
    const observed: FSUtil.Interface = {
      ...fs,
      open: (file, opts) =>
        fs.open(file, opts).pipe(
          Effect.map((handle) => ({
            ...handle,
            stat: handle.stat.pipe(Effect.tap(() => fs.writeFileString(target, "[]" + " ".repeat(200000)))),
            readAlloc: (size) =>
              handle.readAlloc(size).pipe(
                Effect.tap((chunk) =>
                  Effect.sync(() => {
                    sizes.push(Number(size))
                    seen.push(Option.isSome(chunk) ? chunk.value.length : 0)
                  }),
                ),
              ),
          })),
        ),
    }
    const error = yield* Effect.flip(read(observed, target, 65536))
    expect(error).toBeInstanceOf(LimitError)
    expect(sizes).toEqual([65536, 1])
    expect(seen.reduce((sum, value) => sum + value, 0)).toBe(65537)
    expect(Number((yield* fs.stat(target)).size)).toBe(200002)
  }),
)

it.live("exact-byte JSON is accepted while invalid UTF-8 and malformed JSON remain typed failures", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const target = path.join(dir, "receipt.json")
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(target, "[]  ")
    expect(yield* read(fs, target, 4)).toEqual([])
    expect(yield* Effect.flip(read(fs, target, 3))).toBeInstanceOf(LimitError)
    yield* fs.writeFile(target, new Uint8Array([0x5b, 0x22, 0xc0, 0xaf, 0x22, 0x5d]))
    expect(yield* Effect.flip(read(fs, target, 6))).toBeInstanceOf(FSUtil.FileSystemError)
    yield* fs.writeFileString(target, "[")
    expect(yield* Effect.flip(read(fs, target, 6))).toBeInstanceOf(FSUtil.FileSystemError)
    expect(yield* Effect.flip(read(fs, target, Number.POSITIVE_INFINITY))).toBeInstanceOf(LimitError)
  }),
)

it.live("bounded Storage preserves lazy migration, missing errors and owned-root reopening", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const root = path.join(dir, "storage")
    const diffs = [{ file: "kept.txt", additions: 2, deletions: 0 }]
    yield* fs.writeWithDirs(
      path.join(root, "session", "project", "legacy.json"),
      JSON.stringify({ id: "legacy", projectID: "project", summary: { diffs } }),
    )
    const layer = () => Layer.fresh(Storage.layerFromDir(root))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      expect(yield* Effect.flip(storage.readBounded(["missing"], 100))).toBeInstanceOf(Storage.NotFoundError)
      expect(yield* fs.readFileString(path.join(root, "migration"))).toBe("2")
      expect(yield* storage.readBounded(["session_diff", "legacy"], 200)).toEqual(diffs)
      yield* storage.replace(["receipt"], { saved: true })
      expect(yield* storage.readBounded(["receipt"], 100)).toEqual({ saved: true })
      expect(yield* Effect.flip(storage.readBounded(["receipt"], 2))).toBeInstanceOf(LimitError)
    }).pipe(Effect.provide(layer()))
    yield* Effect.gen(function* () {
      expect(yield* (yield* Storage.Service).readBounded(["receipt"], 100)).toEqual({ saved: true })
    }).pipe(Effect.provide(layer()))
  }),
)

it.live("interrupting a bounded read releases its scope and the same Storage write lock", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()
    const target = path.join(dir, "storage", "receipt.json")
    const observed: FSUtil.Interface = {
      ...fs,
      open: (file, opts) =>
        Effect.gen(function* () {
          // Registered first: observe closure only after the real open's scoped finalizer.
          if (file === target) yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined))
          const handle = yield* fs.open(file, opts)
          if (file !== target) return handle
          return {
            ...handle,
            stat: handle.stat,
            readAlloc: (size) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(handle.readAlloc(size)),
              ),
          }
        }),
    }
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.replace(["receipt"], { value: 1 })
      const reading = yield* storage.readBounded(["receipt"], 100).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const writing = yield* storage.replace(["receipt"], { value: 2 }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* fs.readJson(target)).toEqual({ value: 1 })
      yield* Fiber.interrupt(reading)
      yield* Deferred.await(closed)
      yield* Fiber.join(writing)
      expect(yield* fs.readJson(target)).toEqual({ value: 2 })
    }).pipe(
      Effect.provide(
        Storage.layerFromDir(path.join(dir, "storage")).pipe(Layer.provide(Layer.succeed(FSUtil.Service, observed))),
      ),
    )
  }),
)
