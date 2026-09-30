import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import path from "node:path"
import { Database } from "../../src/database/database"
import { makeRuntime } from "../../src/effect/runtime"
import { databaseSnapshot } from "../../src/kilocode/profile-database"
import { tmpdir } from "../fixture/tmpdir"

describe("Core runtime ownership", () => {
  test("failed real finalization retains its rejected disposal and every acquisition fence", async () => {
    class Service extends Context.Service<Service, { value: number }>()("@test/FailedOwnedRuntime") {}
    const layer = Layer.effect(
      Service,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.die(new Error("real finalizer failed")))
        return { value: 1 }
      }),
    )
    const current = makeRuntime(Service, layer)
    const query = (s: { value: number }) => Effect.succeed(s.value)
    expect(await current.runPromise(query)).toBe(1)
    const closed = current.dispose()
    const err = await closed.then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(String(err)).toContain("real finalizer failed")
    expect(current.dispose()).toBe(closed)
    expect(() => current.runPromise(query)).toThrow("Core service runtime is closed")
    expect(() => current.runPromiseExit(query)).toThrow("Core service runtime is closed")
    expect(() => current.runSync(query)).toThrow("Core service runtime is closed")
    expect(() => current.runFork(query)).toThrow("Core service runtime is closed")
    expect(() => current.runCallback(query)).toThrow("Core service runtime is closed")
  })

  test("shared SQLite survives the first owner and closes after the final runtime scope", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "sessions.db")
    const layer = Database.layerFromPath(file)
    const first = makeRuntime(Database.Service, layer)
    const second = makeRuntime(Database.Service, layer)
    try {
      await first.runPromise((s) => s.db.run("CREATE TABLE owner_test(value TEXT)"))
      await first.runPromise((s) => s.db.run("INSERT INTO owner_test VALUES ('first')"))
      await second.runPromise((s) => s.db.run("INSERT INTO owner_test VALUES ('second')"))
      expect(databaseSnapshot(file).instances).toHaveLength(1)
      const closed = first.dispose()
      expect(first.dispose()).toBe(closed)
      expect(() => first.runPromise((s) => s.db.get("SELECT 1"))).toThrow("Core service runtime is closed")
      await closed
      expect(databaseSnapshot(file).instances).toHaveLength(1)
      const rows = await second.runPromise((s) =>
        s.db.all<{ value: string }>("SELECT value FROM owner_test ORDER BY rowid"),
      )
      expect(rows).toEqual([{ value: "first" }, { value: "second" }])
      await second.dispose()
      expect(databaseSnapshot(file).instances).toHaveLength(0)
      expect(() => second.runSync((s) => s.db.get("SELECT 1"))).toThrow("Core service runtime is closed")
    } finally {
      await Promise.all([first.dispose(), second.dispose()])
    }
  }, 30_000)

  test("disposing an unused lazy database runtime prevents initialization by every entrypoint", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "sessions.db")
    const current = makeRuntime(Database.Service, Database.layerFromPath(file))
    const closed = current.dispose()
    const query = (s: Database.Interface) => s.db.get("SELECT 1")
    expect(() => current.runPromise(query)).toThrow("Core service runtime is closed")
    expect(() => current.runPromiseExit(query)).toThrow("Core service runtime is closed")
    expect(() => current.runSync(query)).toThrow("Core service runtime is closed")
    expect(() => current.runFork(query)).toThrow("Core service runtime is closed")
    expect(() => current.runCallback(query)).toThrow("Core service runtime is closed")
    await closed
    expect(await Bun.file(file).exists()).toBe(false)
    expect(databaseSnapshot(file).instances).toHaveLength(0)
  })

  test("a blocked real service finalizer keeps disposal joinable and acquisition closed", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    class Service extends Context.Service<Service, { value: number }>()("@test/OwnedRuntime") {}
    const layer = Layer.effect(
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
    )
    const current = makeRuntime(Service, layer)
    try {
      expect(await current.runPromise((s) => Effect.succeed(s.value))).toBe(1)
      const closed = current.dispose()
      await started.promise
      expect(current.dispose()).toBe(closed)
      expect(() => current.runPromise((s) => Effect.succeed(s.value))).toThrow("Core service runtime is closed")
      release.resolve()
      await closed
    } finally {
      release.resolve()
      await current.dispose()
    }
  })
})
