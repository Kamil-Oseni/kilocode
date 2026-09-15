import { Global } from "@opencode-ai/core/global"
import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"
import { PluginMeta } from "@/plugin/meta"
import { tmpdir } from "../fixture/fixture"

const id = "profile.state.plugin-meta"

test("plugin metadata mutations select state after admission and preserve bytes while closed", async () => {
  await using tmp = await tmpdir()
  const original = Global.Path.state
  const active = path.join(tmp.path, "active")
  const outside = path.join(tmp.path, "outside")
  const plugin = path.join(tmp.path, "plugin.ts")
  await Promise.all([fs.mkdir(active), fs.mkdir(outside), Bun.write(plugin, "export default async () => ({})\n")])
  const registry = ProfileWriterRegistry.make([id])
  await Effect.runPromise(registry.register(id))
  const base = ProfileWriterLive.from(registry, id)
  const seen: ProfileWriterRegistry.Snapshot[] = []
  const admission: ProfileWriterLive.Admission = {
    run: (body) =>
      base.run(
        Effect.sync(() => {
          Global.Path.state = active
        }).pipe(
          Effect.andThen(registry.snapshot),
          Effect.tap((snapshot) => Effect.sync(() => seen.push(snapshot))),
          Effect.andThen(body),
        ),
      ),
  }
  const spec = pathToFileURL(plugin).href

  await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        Global.Path.state = outside
      }),
      () =>
        Effect.gen(function* () {
          const one = yield* Effect.promise(() => PluginMeta.touch(spec, spec, "one", admission))
          expect(one.state).toBe("first")

          Global.Path.state = outside
          yield* Effect.promise(() =>
            PluginMeta.setTheme("one", "dark", { src: plugin, dest: path.join(tmp.path, "dark.json") }, admission),
          )
          Global.Path.state = outside
          const many = yield* Effect.promise(() => PluginMeta.touchMany([{ spec, target: spec, id: "two" }], admission))
          expect(many[0]?.state).toBe("first")
          expect(seen).toHaveLength(3)
          expect(seen.every((snapshot) => snapshot.active.find((item) => item.id === id)?.count === 1)).toBe(true)

          const listed = yield* Effect.promise(() => PluginMeta.list())
          expect(listed.one?.themes?.dark?.src).toBe(plugin)
          expect(listed.two?.load_count).toBe(1)
          expect(seen).toHaveLength(3)
          expect(yield* Effect.promise(() => Bun.file(path.join(outside, "plugin-meta.json")).exists())).toBe(false)

          const file = path.join(active, "plugin-meta.json")
          const before = yield* Effect.promise(() => Bun.file(file).text())
          const entered = yield* Deferred.make<void>()
          const owner = yield* registry
            .quiesce(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(entered)

          Global.Path.state = outside
          const touch = yield* Effect.promise(() => PluginMeta.touch(spec, spec, "one", admission)).pipe(Effect.exit)
          const theme = yield* Effect.promise(() =>
            PluginMeta.setTheme("one", "light", { src: plugin, dest: path.join(tmp.path, "light.json") }, admission),
          ).pipe(Effect.exit)
          expect(Exit.isFailure(touch)).toBe(true)
          expect(Exit.isFailure(theme)).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(before)

          yield* Fiber.interrupt(owner)
          Global.Path.state = outside
          const resumed = yield* Effect.promise(() => PluginMeta.touch(spec, spec, "one", admission))
          Global.Path.state = outside
          yield* Effect.promise(() =>
            PluginMeta.setTheme("one", "light", { src: plugin, dest: path.join(tmp.path, "light.json") }, admission),
          )
          expect(resumed.entry.load_count).toBe(2)
          const after = yield* Effect.promise(() => PluginMeta.list())
          expect(after.one?.themes?.light?.dest).toBe(path.join(tmp.path, "light.json"))
          expect(yield* registry.snapshot).toMatchObject({ phase: "open", active: [] })
        }),
      () =>
        Effect.sync(() => {
          Global.Path.state = original
        }),
    ),
  )
})
