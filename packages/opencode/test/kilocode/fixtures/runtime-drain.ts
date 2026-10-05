import assert from "node:assert/strict"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { databaseSnapshot, drainDatabases, resumeDatabase } from "@opencode-ai/core/kilocode/profile-database"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { makeRuntime } from "../../../src/effect/run-service"

const mode = process.argv[2]
const file = process.env.RAYA_DB!
const query = (s: Database.Interface) => s.db.get("SELECT 1")
const unused = makeRuntime(Database.Service, Database.layerFromPath(`${file}.unused`))

if (mode === "owners") {
  const layer = Database.layerFromPath(file)
  const first = makeRuntime(Database.Service, layer)
  const second = makeRuntime(Database.Service, layer)
  await first.runPromise((s) => s.db.run("CREATE TABLE retirement(value TEXT)"))
  await second.runPromise((s) => s.db.run("INSERT INTO retirement VALUES ('durable')"))
  await makeRuntime(Database.Service, layer).runPromise((s) => s.db.get("SELECT 1"))
  assert.equal(databaseSnapshot(file).instances.length, 1)
  await first.dispose()
  assert.equal(databaseSnapshot(file).instances.length, 1)
  assert.deepEqual(await first.runPromise((s) => s.db.all("SELECT value FROM retirement")), [{ value: "durable" }])

  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  class Held extends Context.Service<Held, number>()("@test/OuterHeld") {}
  const held = makeRuntime(
    Held,
    Layer.effect(
      Held,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => {
            started.resolve()
            return release.promise
          }),
        )
        return 1
      }),
    ),
  )
  class Failed extends Context.Service<Failed, number>()("@test/OuterFailed") {}
  const failed = makeRuntime(
    Failed,
    Layer.effect(
      Failed,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.die(new Error("outer finalizer refusal")))
        return 2
      }),
    ),
  )
  await held.runPromise((value) => Effect.succeed(value))
  await failed.runPromise((value) => Effect.succeed(value))
  const closed = drainDatabases(() => RuntimeRegistry.drain())
  const outcome = closed.then(
    () => undefined,
    (err: unknown) => err,
  )
  assert.equal(
    drainDatabases(() => Promise.reject(new Error("duplicate retirement"))),
    closed,
  )
  await started.promise
  let settled = false
  void outcome.then(() => {
    settled = true
  })
  // The finalizer published its started event and is held by release.promise.
  await Promise.resolve()
  assert.equal(settled, false)
  assert.throws(() => first.runPromise(query), /closed|retired/)
  release.resolve()
  const failure = await outcome
  assert.ok(failure instanceof AggregateError)
  const retirement = await RuntimeRegistry.drain().then(
    () => undefined,
    (err: unknown) => err,
  )
  assert.ok(retirement instanceof AggregateError)
  assert.ok(failure.errors.includes(retirement))
  assert.ok(retirement.errors.some((err: unknown) => String(err).includes("outer finalizer refusal")))
  assert.equal(databaseSnapshot(file).instances.length, 0)
  assert.equal(databaseSnapshot(file).phase, "refused")
  assert.throws(() => resumeDatabase(file), /terminal|closed/)
  assert.throws(() => Database.layerFromPath(`${file}.late`), /terminal|closed|refused/)
  assert.throws(() => makeRuntime(Database.Service, layer), /closed/)
  assert.throws(() => second.runPromise(query), /closed|retired/)
} else {
  const { AppRuntime } = await import("../../../src/effect/app-runtime")
  if (mode === "app-used") {
    await AppRuntime.runPromise(Database.Service.use((s) => s.db.run("CREATE TABLE app_retirement(value TEXT)")))
    assert.ok(databaseSnapshot(file).instances.length > 0)
  }
  const receipt = await drainDatabases(() => RuntimeRegistry.drain())
  assert.equal(receipt.processLocal, true)
  assert.equal(receipt.portableCaptureAuthorized, false)
  assert.ok(receipt.roots.every((root) => root.instances === 0))
  assert.equal(databaseSnapshot(file).instances.length, 0)
  assert.throws(() => Database.layerFromPath(`${file}.late`), /terminal|closed/)
  const effect = Effect.void
  assert.throws(() => AppRuntime.runPromise(effect), /closed|retired/)
  assert.throws(() => AppRuntime.runPromiseExit(effect), /closed|retired/)
  assert.throws(() => AppRuntime.runSync(effect), /closed|retired/)
  assert.throws(() => AppRuntime.runFork(effect), /closed|retired/)
  assert.throws(() => AppRuntime.runCallback(effect), /closed|retired/)
  await AppRuntime.dispose()
  if (mode === "app-unused") assert.equal(await Bun.file(file).exists(), false)
}
assert.equal(await Bun.file(`${file}.unused`).exists(), false)
assert.equal(await Bun.file(`${file}.late`).exists(), false)
assert.throws(() => unused.runPromise(query), /closed|retired/)
console.log(JSON.stringify({ ok: true, mode, instances: databaseSnapshot(file).instances.length }))
