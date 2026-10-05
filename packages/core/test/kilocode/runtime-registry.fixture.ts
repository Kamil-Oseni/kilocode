import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import path from "node:path"
import { Database } from "../../src/database/database"
import { makeRuntime } from "../../src/effect/runtime"
import { databaseSnapshot } from "../../src/kilocode/profile-database"
import { RuntimeRegistry } from "../../src/kilocode/runtime-registry"
import { tmpdir } from "../fixture/tmpdir"

// Global retirement is terminal. Keep this real-runtime integration out of the parent runner.
test("global retirement fences every facade and joins real held, failed and SQLite finalizers", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "sessions.db")
  const unused = path.join(dir.path, "unused.db")
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  class Service extends Context.Service<Service, { value: number }>()("@test/RegistryHeld") {}
  class Failure extends Context.Service<Failure, { value: number }>()("@test/RegistryFailure") {}
  const held = makeRuntime(
    Service,
    Layer.effect(
      Service,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            started.resolve()
            await release.promise
          }),
        )
        return { value: 1 }
      }),
    ),
  )
  const failed = makeRuntime(
    Failure,
    Layer.effect(
      Failure,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.die(new Error("registry real finalizer failed")))
        return { value: 2 }
      }),
    ),
  )
  const layer = Database.layerFromPath(file)
  const first = makeRuntime(Database.Service, layer)
  const second = makeRuntime(Database.Service, layer)
  const lazy = makeRuntime(Database.Service, Database.layerFromPath(unused))
  try {
    expect(await held.runPromise((s) => Effect.succeed(s.value))).toBe(1)
    expect(await failed.runPromise((s) => Effect.succeed(s.value))).toBe(2)
    await first.runPromise((s) => s.db.run("CREATE TABLE registry_test(value TEXT)"))
    await second.runPromise((s) => s.db.run("INSERT INTO registry_test VALUES ('persisted')"))
    expect(databaseSnapshot(file).instances).toHaveLength(1)
    const closed = RuntimeRegistry.drain()
    const failure = closed.catch((err: unknown) => err)
    expect(RuntimeRegistry.drain()).toBe(closed)
    expect(() => held.runPromise((s) => Effect.succeed(s.value))).toThrow("runtime is closed")
    expect(() => failed.runPromise((s) => Effect.succeed(s.value))).toThrow("runtime is closed")
    const query = (s: Database.Interface) => s.db.get("SELECT 1")
    for (const owner of [first, second, lazy]) {
      expect(() => owner.runPromise(query)).toThrow("runtime is closed")
      expect(() => owner.runPromiseExit(query)).toThrow("runtime is closed")
      expect(() => owner.runSync(query)).toThrow("runtime is closed")
      expect(() => owner.runFork(query)).toThrow("runtime is closed")
      expect(() => owner.runCallback(query)).toThrow("runtime is closed")
    }
    expect(() => makeRuntime(Database.Service, Database.layerFromPath(unused))).toThrow("registration is closed")
    await started.promise
    let settled = false
    void failure.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    const err = await failure
    expect(err).toBeInstanceOf(AggregateError)
    if (!(err instanceof AggregateError)) throw err
    expect(String(err.errors[0])).toContain("registry real finalizer failed")
    expect(RuntimeRegistry.drain()).toBe(closed)
    expect(await RuntimeRegistry.drain().catch((err: unknown) => err)).toBe(err)
    expect(databaseSnapshot(file).instances).toHaveLength(0)
    expect(databaseSnapshot(unused).instances).toHaveLength(0)
    expect(await Bun.file(unused).exists()).toBe(false)
  } finally {
    release.resolve()
    await Promise.allSettled([held.dispose(), failed.dispose(), first.dispose(), second.dispose(), lazy.dispose()])
  }
}, 30_000)
