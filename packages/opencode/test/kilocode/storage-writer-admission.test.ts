import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import path from "node:path"
import { Git } from "@/git"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))

describe("JSON Storage writer admission", () => {
  it.live("admits initialization and every mutation while preserving reads", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const dir = path.join(root, "storage")
      const registry = ProfileWriterRegistry.make(["profile.storage.json"])
      yield* registry.register("profile.storage.json")
      const base = ProfileWriterLive.from(registry, "profile.storage.json")
      const seen: ProfileWriterRegistry.Snapshot[] = []
      const admission: ProfileWriterLive.Admission = {
        run: (body) =>
          base.run(
            registry.snapshot.pipe(
              Effect.tap((snapshot) => Effect.sync(() => seen.push(snapshot))),
              Effect.andThen(body),
            ),
          ),
      }

      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        yield* storage.write(["item"], { value: 1 })
        expect(yield* storage.create(["claim"], { value: 1 })).toBe(true)
        yield* storage.replace(["claim"], { value: 2 })
        yield* storage.update<{ value: number }>(["item"], (item) => item.value++)
        yield* storage.remove(["claim"])
        expect(yield* storage.read<{ value: number }>(["item"])).toEqual({ value: 2 })
      }).pipe(Effect.provide(Storage.layerFromDir(dir, admission)))

      expect(seen.length).toBe(6)
      expect(seen.every((snapshot) => snapshot.active.some((item) => item.id === "profile.storage.json"))).toBe(true)
      expect(seen.every((snapshot) => snapshot.active.every((item) => item.count === 1))).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "migration")).text())).toBe("2")
      expect(yield* registry.snapshot).toMatchObject({ phase: "open", active: [] })
    }),
  )

  it.live("refuses a real Storage mutation while quiescence owns admission", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const dir = path.join(root, "storage")
      const registry = ProfileWriterRegistry.make(["profile.storage.json"])
      yield* registry.register("profile.storage.json")
      const admission = ProfileWriterLive.from(registry, "profile.storage.json")

      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const entered = yield* Deferred.make<void>()
        const owner = yield* registry
          .quiesce(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)

        const blocked = yield* storage.write(["before"], { value: 1 }).pipe(Effect.exit)
        expect(Exit.isFailure(blocked)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "migration")).exists())).toBe(false)

        yield* Fiber.interrupt(owner)
        yield* storage.write(["before"], { value: 1 })

        const resumed = yield* Deferred.make<void>()
        const second = yield* registry
          .quiesce(Deferred.succeed(resumed, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(resumed)

        const late = yield* storage.write(["late"], { value: 2 }).pipe(Effect.exit)
        expect(Exit.isFailure(late)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "late.json")).exists())).toBe(false)

        yield* Fiber.interrupt(second)
        yield* storage.write(["after"], { value: 3 })
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "after.json")).json())).toEqual({ value: 3 })
      }).pipe(Effect.provide(Storage.layerFromDir(dir, admission)))
    }),
  )
})
