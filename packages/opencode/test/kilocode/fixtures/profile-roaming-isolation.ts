import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile, realpath } from "node:fs/promises"
import type { Column } from "../../../src/kilocode/migration/profile-restore"
import { isolate } from "../../../src/kilocode/migration/profile-import-isolation"

const trap = process.argv[2]
assert.ok(trap && path.isAbsolute(trap))
assert.equal(process.env.APPDATA, trap)
const original = path.join(trap, "Code", "User", "globalStorage", "kilocode.kilo-code", "settings", "custom_modes.yaml")
const before = await readFile(original, "utf8")
const root = await isolate()
assert.equal(process.env.APPDATA, path.join(root, "roaming"))
const [
  { KilocodePaths },
  { ModesMigrator },
  { Effect, ManagedRuntime },
  { Database },
  { payload, seal, tables },
  { restore, signature },
  { finish },
] = await Promise.all([
  import("../../../src/kilocode/paths"),
  import("../../../src/kilocode/modes-migrator"),
  import("effect"),
  import("@opencode-ai/core/database/database"),
  import("../../../src/kilocode/migration/profile-bundle"),
  import("../../../src/kilocode/migration/profile-restore"),
  import("../../../src/kilocode/cli/finish"),
])
try {
  const directory = path.join(root, "workspace")
  await mkdir(directory)
  const project = await realpath(directory)
  assert.equal(
    KilocodePaths.vscodeGlobalStorage(),
    path.join(root, "roaming", "Code", "User", "globalStorage", "kilocode.kilo-code"),
  )
  assert.equal((await ModesMigrator.migrate({ projectDir: project })).agents["original-roaming-marker"], undefined)
  process.env.APPDATA = trap
  assert.ok((await ModesMigrator.migrate({ projectDir: project })).agents["original-roaming-marker"])
  process.env.APPDATA = path.join(root, "roaming")
  const runtime = ManagedRuntime.make(Database.layerFromPath(path.join(root, "source.sqlite")))
  const source = await runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sql = yield* Effect.forEach(tables, (table) =>
        Effect.gen(function* () {
          const columns = yield* database.db.all<{ name: string }>(`PRAGMA table_info('${table}')`)
          const rows = yield* database.db.all<Record<string, string | number | null>>(`SELECT * FROM "${table}"`)
          return {
            table,
            columns: columns.map((column) => column.name),
            rows: rows.map((row) => columns.map((column) => row[column.name])),
          }
        }),
      )
      return payload.parse({
        format: "raya.profile-data",
        version: 1,
        id: crypto.randomUUID(),
        createdAt: 100,
        schema: yield* signature((query) => database.db.all<Column>(query)),
        workspaces: [],
        sql,
        json: [],
        review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
      })
    }),
  )
  await runtime.dispose()
  const text = await seal(source, "Private roaming fixture passphrase")
  const target = path.join(root, "restored")
  const restored = await restore(text, "Private roaming fixture passphrase", target, {})
  assert.equal(restored.reviewed, false)
  assert.equal(restored.env.APPDATA, path.join(target, "roaming"))
  Object.assign(process.env, restored.env)
  assert.equal(
    KilocodePaths.vscodeGlobalStorage(),
    path.join(target, "roaming", "Code", "User", "globalStorage", "kilocode.kilo-code"),
  )
  assert.equal((await ModesMigrator.migrate({ projectDir: project })).agents["original-roaming-marker"], undefined)
  assert.equal(await readFile(original, "utf8"), before)
  console.log(
    "ROAMING_ISOLATION_OK " +
      JSON.stringify({
        importer: true,
        restored: true,
        actualLegacyDiscovery: true,
        sourceUnchanged: true,
        permissionGranted: false,
      }),
  )
} catch (err) {
  process.exitCode = 1
  console.error(err)
} finally {
  await finish([])
}
