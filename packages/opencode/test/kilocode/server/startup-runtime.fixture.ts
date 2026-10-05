import assert from "node:assert/strict"
import path from "node:path"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { databaseSnapshot } from "@opencode-ai/core/kilocode/profile-database"
import { runtimeOwner } from "@/kilocode/runtime-owner"

const root = process.env.RAYA_RETIREMENT_PROFILE
assert.ok(root)
const file = path.join(root, "owned.db")
const mode = process.argv[2]

if (mode === "unused") {
  const owner = runtimeOwner(() => ManagedRuntime.make(Database.layerFromPath(file)))
  owner.get()
  await owner.retire()
  assert.equal(await Bun.file(file).exists(), false)
  assert.equal(databaseSnapshot(file).instances.length, 0)
}

if (mode === "held") {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  class Service extends Context.Service<Service, number>()("@test/JoinedStartup") {}
  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run("CREATE TABLE startup(value TEXT)")
      started.resolve()
      yield* Effect.promise(() => release.promise)
      yield* db.run("INSERT INTO startup VALUES ('settled')")
      return 1
    }),
  ).pipe(Layer.provide(Database.layerFromPath(file)))
  const owner = runtimeOwner(
    () => ManagedRuntime.make(layer),
    (active) => active.context(),
  )
  const running = owner.get().runPromise(Service.use((value) => Effect.succeed(value)))
  await started.promise
  const closing = owner.retire()
  assert.equal(owner.retire(), closing)
  assert.throws(() => owner.get(), /retired/)
  let settled = false
  void closing.then(() => {
    settled = true
  })
  await Bun.sleep(25)
  assert.equal(settled, false)
  assert.equal(databaseSnapshot(file).instances.length, 1)
  release.resolve()
  assert.equal(await running, 1)
  await closing
  assert.equal(databaseSnapshot(file).instances.length, 0)
  const { Database: Native } = await import("bun:sqlite")
  const native = new Native(file, { readonly: true })
  assert.deepEqual(native.query("SELECT value FROM startup").all(), [{ value: "settled" }])
  native.close()
}

console.log(JSON.stringify({ passed: true, mode }))
