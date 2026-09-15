import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { utimes } from "node:fs/promises"
import path from "node:path"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"
import { Truncate } from "@/tool/truncate"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node])))
const id = "profile.data.tool-output"

describe("managed tool-output writer admission", () => {
  it.live("pins write and cleanup paths, refuses closed admission, and resumes", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const outside = path.join(root, "outside")
      const data = path.join(root, "data")
      const output = path.join(data, "tool-output")
      const fs = yield* FSUtil.Service
      yield* Effect.forEach([outside, output], (dir) => fs.makeDirectory(dir, { recursive: true }), { discard: true })
      const registry = ProfileWriterRegistry.make([id])
      yield* registry.register(id)
      const base = ProfileWriterLive.from(registry, id)
      const seen: ProfileWriterRegistry.Snapshot[] = []
      const admission: ProfileWriterLive.Admission = {
        run: (body) =>
          base.run(
            Effect.sync(() => {
              Global.Path.data = data
            }).pipe(
              Effect.andThen(registry.snapshot),
              Effect.tap((snapshot) => Effect.sync(() => seen.push(snapshot))),
              Effect.andThen(body),
            ),
          ),
      }
      const original = Global.Path.data

      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          Global.Path.data = outside
        }),
        () =>
          Effect.gen(function* () {
            const service = yield* Truncate.Service
            const first = yield* service.write("first")
            expect(first.startsWith(output)).toBe(true)

            const old = path.join(output, "tool_old")
            yield* fs.writeFileString(old, "old")
            const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
            yield* Effect.promise(() => utimes(old, stale, stale))
            Global.Path.data = outside
            yield* service.cleanup()
            expect(yield* fs.exists(old)).toBe(false)

            Global.Path.data = outside
            const large = yield* service.output("first\nsecond", { maxLines: 1 })
            expect(large.truncated).toBe(true)
            const count = seen.length
            expect(count).toBe(3)
            expect(seen.every((snapshot) => snapshot.active.find((item) => item.id === id)?.count === 1)).toBe(true)

            expect((yield* service.output("small", { maxLines: 2 })).truncated).toBe(false)
            expect(seen).toHaveLength(count)
            expect(
              yield* fs.readDirectory(path.join(outside, "tool-output")).pipe(Effect.orElseSucceed(() => [])),
            ).toEqual([])

            const canary = path.join(output, "tool_canary")
            yield* fs.writeFileString(canary, "keep")
            yield* Effect.promise(() => utimes(canary, stale, stale))
            const before = yield* fs.readDirectory(output)
            const entered = yield* Deferred.make<void>()
            const owner = yield* registry
              .quiesce(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
              .pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(entered)

            Global.Path.data = outside
            expect(Exit.isFailure(yield* service.write("blocked").pipe(Effect.exit))).toBe(true)
            expect(Exit.isFailure(yield* service.cleanup().pipe(Effect.exit))).toBe(true)
            expect(yield* fs.readDirectory(output)).toEqual(before)
            expect(yield* fs.readFileString(canary)).toBe("keep")

            yield* Fiber.interrupt(owner)
            Global.Path.data = outside
            yield* service.cleanup()
            expect(yield* fs.exists(canary)).toBe(false)
            Global.Path.data = outside
            const resumed = yield* service.write("resumed")
            expect(yield* fs.readFileString(resumed)).toBe("resumed")
            expect(yield* registry.snapshot).toMatchObject({ phase: "open", active: [] })
          }).pipe(Effect.provide(Truncate.layerWithAdmission(admission))),
        () =>
          Effect.sync(() => {
            Global.Path.data = original
          }),
      )
    }),
  )
})
