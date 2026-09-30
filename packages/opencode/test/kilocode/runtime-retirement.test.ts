import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { databaseSnapshot } from "@opencode-ai/core/kilocode/profile-database"
import { makeRuntime } from "../../src/effect/run-service"

test("reset preserves shared SQLite and reuse; terminal retirement closes the final owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-runtime-retirement-"))
  const file = join(dir, "sessions.db")
  const layer = Database.layerFromPath(file)
  const first = makeRuntime(Database.Service, layer)
  const second = makeRuntime(Database.Service, layer)
  try {
    await first.runPromise((s) => s.db.run("CREATE TABLE retirement_test(value TEXT)"))
    await first.runPromise((s) => s.db.run("INSERT INTO retirement_test VALUES ('first')"))
    await second.runPromise((s) => s.db.run("INSERT INTO retirement_test VALUES ('second')"))
    expect(databaseSnapshot(file).instances).toHaveLength(1)
    const reset = first.dispose()
    expect(first.dispose()).toBe(reset)
    expect(() => first.runPromise((s) => s.db.get("SELECT 1"))).toThrow("Service runtime is closing")
    await reset
    expect(databaseSnapshot(file).instances).toHaveLength(1)
    const rows = await first.runPromise((s) =>
      s.db.all<{ value: string }>("SELECT value FROM retirement_test ORDER BY rowid"),
    )
    expect(rows).toEqual([{ value: "first" }, { value: "second" }])
    await second.retire()
    expect(databaseSnapshot(file).instances).toHaveLength(1)
    const closed = first.retire()
    expect(first.retire()).toBe(closed)
    await closed
    expect(first.retire()).toBe(closed)
    expect(databaseSnapshot(file).instances).toHaveLength(0)
    expect(() => first.runSync((s) => s.db.get("SELECT 1"))).toThrow("Service runtime is retired")
  } finally {
    await Promise.all([first.retire(), second.retire()])
    await remove(dir)
  }
}, 30_000)

test("retiring an unused lazy facade fences every entrypoint without creating SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-runtime-unused-"))
  const file = join(dir, "sessions.db")
  const current = makeRuntime(Database.Service, Database.layerFromPath(file))
  try {
    const closed = current.retire()
    const query = (s: Database.Interface) => s.db.get("SELECT 1")
    expect(() => current.runPromise(query)).toThrow("Service runtime is retired")
    expect(() => current.runPromiseExit(query)).toThrow("Service runtime is retired")
    expect(() => current.runSync(query)).toThrow("Service runtime is retired")
    expect(() => current.runFork(query)).toThrow("Service runtime is retired")
    expect(() => current.runCallback(query)).toThrow("Service runtime is retired")
    await closed
    expect(current.retire()).toBe(closed)
    expect(await Bun.file(file).exists()).toBe(false)
    expect(databaseSnapshot(file).instances).toHaveLength(0)
  } finally {
    await current.retire()
    await remove(dir)
  }
})

test("retirement joins an in-flight reset finalizer and never admits another generation", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let built = 0
  class Service extends Context.Service<Service, { value: number }>()("@test/RetiringRuntime") {}
  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      built += 1
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
    const reset = current.dispose()
    await started.promise
    expect(() => current.runPromise((s) => Effect.succeed(s.value))).toThrow("Service runtime is closing")
    const retired = current.retire()
    expect(retired).toBe(reset)
    expect(current.retire()).toBe(retired)
    expect(() => current.runPromise((s) => Effect.succeed(s.value))).toThrow("Service runtime is retired")
    release.resolve()
    await retired
    expect(current.retire()).toBe(retired)
    expect(built).toBe(1)
  } finally {
    release.resolve()
    await current.retire()
  }
})

test("a failed real finalizer keeps reset acquisition closed and terminal failure joinable", async () => {
  class Service extends Context.Service<Service, { value: number }>()("@test/FailedRetiringRuntime") {}
  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.die(new Error("retirement finalizer failed")))
      return { value: 1 }
    }),
  )
  const current = makeRuntime(Service, layer)
  expect(await current.runPromise((s) => Effect.succeed(s.value))).toBe(1)
  const closed = current.dispose()
  const failure = await closed.then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(String(failure)).toContain("retirement finalizer failed")
  expect(current.dispose()).toBe(closed)
  expect(() => current.runPromise((s) => Effect.succeed(s.value))).toThrow("Service runtime is closing")
  expect(current.retire()).toBe(closed)
  expect(() => current.runPromise((s) => Effect.succeed(s.value))).toThrow("Service runtime is retired")
})

async function remove(dir: string) {
  const root = resolve(tmpdir())
  const path = resolve(dir)
  const key = relative(root, path)
  if (!key || key.startsWith("..") || isAbsolute(key) || !basename(path).startsWith("raya-runtime-"))
    throw new Error("Runtime fixture cleanup escaped its temporary directory")
  await rm(path, { recursive: true, force: true })
}
