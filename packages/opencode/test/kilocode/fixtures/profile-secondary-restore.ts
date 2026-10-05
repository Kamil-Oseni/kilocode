import assert from "node:assert/strict"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { payload, seal, tables } from "@/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "@/kilocode/migration/profile-restore"
import { historical } from "@/kilocode/migration/profile-evidence"
import { finish } from "@/kilocode/cli/finish"

const root = process.argv[2]
assert.ok(root && path.isAbsolute(root))
const input = payload.parse(JSON.parse(await readFile(path.join(root, "secondary-input.json"), "utf8")))
assert.ok(input.secondary)
const source = path.join(root, "shipped-schema")
await mkdir(source)
const sql = await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const schema = yield* signature((query) => database.db.all<Column>(query))
    const values = yield* Effect.forEach(tables, (table) =>
      Effect.gen(function* () {
        const columns = yield* database.db.all<Column>(`PRAGMA table_info('${table}')`)
        return { table, columns: columns.map((column) => column.name), rows: [] }
      }),
    )
    return { schema, sql: payload.shape.sql.parse(values) }
  }).pipe(Effect.provide(Database.layerFromPath(path.join(source, "raya.db")))),
)
const password = "synthetic secondary inactive restore passphrase"
const value = payload.parse({ ...input, ...sql })
assert.ok(value.secondary)
const mappings: Record<string, string> = {}
for (const [index, workspace] of value.workspaces.entries()) {
  mappings[workspace] = path.join(root, "mapped", String(index))
  await mkdir(mappings[workspace], { recursive: true })
}
const result = await restore(await seal(value, password), password, path.join(root, "destination"), mappings)
assert.equal(result.reviewed, false)
assert.ok(result.hold)
assert.deepEqual(JSON.parse(await readFile(path.join(result.path, "restore-secondary.json"), "utf8")), value.secondary)
assert.equal(
  await stat(path.join(result.path, "memory")).then(
    () => true,
    (err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return false
      throw err
    },
  ),
  false,
)
assert.equal(
  await stat(path.join(result.path, "snapshot")).then(
    () => true,
    (err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return false
      throw err
    },
  ),
  false,
)
const history = await historical(result.path)
assert.deepEqual(history.at(-1)?.secondary, value.secondary)
assert.equal(history.length, 2)
await writeFile(
  path.join(root, "secondary-restore-receipt.json"),
  JSON.stringify({
    ok: true,
    held: true,
    inactive: true,
    namespaces: value.secondary.namespaces.length,
    historical: history.length,
    modelCalls: 0,
  }),
  { flag: "wx" },
)
await finish([])
