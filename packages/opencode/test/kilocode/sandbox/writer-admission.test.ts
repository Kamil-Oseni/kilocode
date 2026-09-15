import { Global } from "@opencode-ai/core/global"
import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"
import { SandboxPreference } from "@/kilocode/sandbox/preference"
import { SandboxStore } from "@/kilocode/sandbox/store"
import { SessionID } from "@/session/schema"
import { tmpdir } from "../../fixture/fixture"

const ids = ["profile.state.sandbox-policy", "profile.state.sandbox-preference"] as const

test("sandbox state writers select roots after admission and preserve bytes while closed", async () => {
  await using tmp = await tmpdir()
  const original = Global.Path.state
  const active = path.join(tmp.path, "active")
  const outside = path.join(tmp.path, "outside")
  const directory = path.join(tmp.path, "project")
  await Promise.all([fs.mkdir(active), fs.mkdir(outside)])
  const registry = ProfileWriterRegistry.make(ids)
  await Effect.runPromise(Effect.forEach(ids, (id) => registry.register(id), { discard: true }))
  const seen: string[] = []
  const admission = (id: (typeof ids)[number]): ProfileWriterLive.Admission => {
    const base = ProfileWriterLive.from(registry, id)
    return {
      run: (body) =>
        base.run(
          Effect.sync(() => {
            Global.Path.state = path.join(active, "kilo")
          }).pipe(
            Effect.andThen(registry.snapshot),
            Effect.tap((snapshot) =>
              Effect.sync(() => {
                expect(snapshot.active.find((item) => item.id === id)?.count).toBe(1)
                seen.push(id)
              }),
            ),
            Effect.andThen(body),
          ),
        ),
    }
  }
  const policy = admission(ids[0])
  const preference = admission(ids[1])
  const first = SessionID.make("ses_sandbox_writer_first")
  const second = SessionID.make("ses_sandbox_writer_second")
  const canary = SessionID.make("ses_sandbox_writer_canary")
  const snapshot: SandboxStore.Snapshot = {
    enabled: true,
    mode: "deny",
    allowedHosts: [],
    writablePaths: [],
    version: 1,
  }

  await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        Global.Path.state = path.join(outside, "kilo")
      }),
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(() => SandboxPreference.write(directory, true, preference))
          Global.Path.state = path.join(outside, "kilo")
          yield* Effect.promise(() => SandboxStore.write(directory, first, snapshot, policy))
          expect(yield* Effect.promise(() => SandboxPreference.read(directory))).toBe(true)
          expect(yield* Effect.promise(() => SandboxStore.read(directory, first))).toEqual(snapshot)

          Global.Path.state = path.join(outside, "kilo")
          yield* Effect.promise(() => SandboxStore.remove(directory, first, policy))
          expect(yield* Effect.promise(() => SandboxStore.read(directory, first))).toBeUndefined()
          Global.Path.state = path.join(outside, "kilo")
          yield* Effect.promise(() => SandboxStore.write(directory, second, snapshot, policy))
          Global.Path.state = path.join(outside, "kilo")
          yield* Effect.promise(() => SandboxStore.dispose(second, policy))
          expect(yield* Effect.promise(() => SandboxStore.read(directory, second))).toBeUndefined()

          expect(seen.filter((id) => id === ids[0])).toHaveLength(4)
          expect(seen.filter((id) => id === ids[1])).toHaveLength(1)
          expect(
            yield* Effect.promise(() =>
              fs.readdir(path.join(outside, "kilo-sandbox-policy")).catch(() => [] as string[]),
            ),
          ).toEqual([])
          expect(
            yield* Effect.promise(() =>
              fs.readdir(path.join(outside, "kilo-sandbox-preference")).catch(() => [] as string[]),
            ),
          ).toEqual([])

          Global.Path.state = path.join(outside, "kilo")
          yield* Effect.promise(() => SandboxStore.write(directory, canary, snapshot, policy))
          const entered = yield* Deferred.make<void>()
          const owner = yield* registry
            .quiesce(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(entered)

          Global.Path.state = path.join(outside, "kilo")
          const pref = yield* Effect.promise(() => SandboxPreference.write(directory, false, preference)).pipe(
            Effect.exit,
          )
          const write = yield* Effect.promise(() =>
            SandboxStore.write(directory, canary, { ...snapshot, version: 2 }, policy),
          ).pipe(Effect.exit)
          const remove = yield* Effect.promise(() => SandboxStore.remove(directory, canary, policy)).pipe(Effect.exit)
          const dispose = yield* Effect.promise(() => SandboxStore.dispose(canary, policy)).pipe(Effect.exit)
          expect([pref, write, remove, dispose].every(Exit.isFailure)).toBe(true)

          Global.Path.state = path.join(active, "kilo")
          expect(yield* Effect.promise(() => SandboxPreference.read(directory))).toBe(true)
          expect(yield* Effect.promise(() => SandboxStore.read(directory, canary))).toEqual(snapshot)

          yield* Fiber.interrupt(owner)
          Global.Path.state = path.join(outside, "kilo")
          yield* Effect.promise(() => SandboxPreference.write(directory, false, preference))
          Global.Path.state = path.join(outside, "kilo")
          yield* Effect.promise(() => SandboxStore.remove(directory, canary, policy))
          expect(yield* Effect.promise(() => SandboxPreference.read(directory))).toBe(false)
          expect(yield* Effect.promise(() => SandboxStore.read(directory, canary))).toBeUndefined()
          expect(yield* registry.snapshot).toMatchObject({ phase: "open", active: [] })
        }),
      () =>
        Effect.sync(() => {
          Global.Path.state = original
        }),
    ),
  )
})
