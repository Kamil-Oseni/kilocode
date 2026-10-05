import assert from "node:assert/strict"
import { Database as Sqlite } from "bun:sqlite"
import { existsSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { databaseSnapshot } from "@opencode-ai/core/kilocode/profile-database"
import { makeRuntime } from "../../../src/effect/run-service"
import { retire } from "../../../src/kilocode/cli/database-retirement"
import { retire as worker } from "../../../src/kilocode/cli/cmd/tui/worker-shutdown"

const mode = process.argv[2]
const file = process.env.RAYA_DB
if (!file) throw new Error("Missing private legacy retirement database")
const root = dirname(file)
const markers = async (kind: string) => {
  const dir = join(root, ".raya-profile-locks")
  if (!existsSync(dir)) return []
  const dirs = (await readdir(dir)).filter((name) => name.endsWith(`.${kind}`))
  const files = await Promise.all(
    dirs.map(async (name) => (await readdir(join(dir, name))).map((file) => join(dir, name, file))),
  )
  return files.flat()
}
const started = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
class Held extends Context.Service<Held, number>()("@test/LegacyRetirementHeld") {}
const owner = makeRuntime(
  Held,
  Layer.effect(
    Held,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        mode === "failed"
          ? Effect.die(new Error("actual legacy retirement owner failure"))
          : mode === "held"
            ? Effect.promise(() => {
                started.resolve()
                return release.promise
              })
            : Effect.void,
      )
      return 1
    }),
  ),
)
await owner.runPromise((value) => Effect.succeed(value))

if (mode === "unused") {
  assert.equal(existsSync(file), false)
  const closing = retire()
  assert.equal(retire(), closing)
  assert.equal(worker(), closing)
  await closing
  assert.equal(existsSync(file), false)
  assert.equal((await markers("owners")).length, 0)
  assert.equal((await markers("writers")).length, 0)
} else {
  const core = makeRuntime(Database.Service, Database.layerFromPath(file))
  await core.runPromise((db) => db.db.run("CREATE TABLE legacy_retirement(value TEXT)"))
  await core.runPromise((db) => db.db.run("INSERT INTO legacy_retirement VALUES ('core')"))
  const prior = await markers("owners")
  const legacy = await import("../../../src/storage/db")
  // This gate covers native ownership, not the independent legacy SQL migration
  // path, whose sole ALTER expects a pre-existing legacy session table.
  const client = legacy.Client({ disableChannelDb: true, skipMigrations: true })
  client.$client.exec("INSERT INTO legacy_retirement VALUES ('legacy')")
  const marker = (await markers("owners")).find((file) => !prior.includes(file))
  assert.ok(marker)
  const original = await readFile(marker, "utf8")
  assert.ok(databaseSnapshot(file).instances.length > 0)
  assert.equal((await markers("owners")).length, 2)
  if (mode === "failed") await writeFile(marker, `${original}\nchanged-owner`)
  const closing = retire()
  const result = closing.then(
    () => undefined,
    (err: unknown) => err,
  )
  assert.equal(retire(), closing)
  assert.equal(worker(), closing)
  if (mode === "held") {
    await started.promise
    assert.equal(legacy.Client.loaded(), true)
    assert.ok((await markers("owners")).length > 0)
    assert.deepEqual(client.$client.query("SELECT value FROM legacy_retirement ORDER BY rowid").all(), [
      { value: "core" },
      { value: "legacy" },
    ])
    let settled = false
    void result.then(() => {
      settled = true
    })
    await Promise.resolve()
    assert.equal(settled, false)
    release.resolve()
  }
  const failure = await result
  assert.equal(databaseSnapshot(file).instances.length, 0)
  if (mode === "failed") {
    assert.ok(failure instanceof AggregateError)
    const text = (err: unknown): string =>
      err instanceof AggregateError ? `${err.message}: ${err.errors.map(text).join("; ")}` : String(err)
    assert.match(text(failure), /actual legacy retirement owner failure/)
    assert.match(text(failure), /Refusing to release changed native ownership/)
    assert.equal(await retire().catch((err: unknown) => err), failure)
    assert.equal(legacy.Client.loaded(), true)
    assert.equal((await markers("owners")).length, 1)
    assert.equal(databaseSnapshot(file).phase, "refused")
    assert.throws(() => client.$client.query("SELECT 1").get(), /closed|finalized|invalid/i)
  } else {
    assert.equal(failure, undefined)
    assert.equal(legacy.Client.loaded(), false)
    assert.equal((await markers("owners")).length, 0)
    assert.equal((await markers("writers")).length, 0)
    assert.equal(databaseSnapshot(file).phase, "closed")
    using database = new Sqlite(file, { readonly: true })
    assert.deepEqual(database.query("SELECT value FROM legacy_retirement ORDER BY rowid").all(), [
      { value: "core" },
      { value: "legacy" },
    ])
  }
}
await Bun.write(
  join(root, "receipt.json"),
  JSON.stringify({
    passed: true,
    mode,
    coreInstances: mode === "unused" ? 0 : databaseSnapshot(file).instances.length,
    nativeMarkers: (await markers("owners")).length,
    operationMarkers: (await markers("writers")).length,
    processLocal: true,
    portableCaptureAuthorized: false,
  }),
)
