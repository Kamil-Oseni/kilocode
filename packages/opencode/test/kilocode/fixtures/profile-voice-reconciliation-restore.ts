import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { payload, seal, tables } from "@/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "@/kilocode/migration/profile-restore"
import { finish } from "@/kilocode/cli/finish"

const root = process.argv[2]
assert(root && path.isAbsolute(root))
const input = payload.parse(JSON.parse(await readFile(path.join(root, "voice-input.json"), "utf8")))
assert(input.voice)
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
  }).pipe(Effect.provide(Database.layerFromPath(path.join(root, "shipped.db")))),
)
const original = payload.parse({ ...input, ...sql })
const password = "private voice inactive codec fixture password"
const first = await restore(await seal(original, password), password, path.join(root, "first"), {})
const prior = JSON.parse(await readFile(path.join(first.path, "restore-source.json"), "utf8"))
const next = payload.parse({
  ...original,
  id: crypto.randomUUID(),
  archives: [Object.fromEntries(Object.entries(prior).filter(([key]) => key !== "archives"))],
})
const second = await restore(await seal(next, password), password, path.join(root, "second"), {})
for (const result of [first, second]) {
  assert.deepEqual(
    JSON.parse(await readFile(path.join(result.path, "restore-voice-reconciliation.json"), "utf8")),
    input.voice,
  )
  assert.equal(
    await Bun.file(path.join(result.path, "storage/raya/voice/usage-reconciliation/v1.json")).exists(),
    false,
  )
  assert.equal(await Bun.file(path.join(result.path, "storage/raya/voice-reconciliation")).exists(), false)
  assert.equal(result.reviewed, false)
  assert.equal(
    JSON.parse(await readFile(path.join(result.path, "storage/raya/restore-hold.json"), "utf8")).state,
    "held",
  )
}
const saved = JSON.parse(await readFile(path.join(second.path, "restore-source.json"), "utf8"))
assert.deepEqual(saved.archives.find((item: { id: string }) => item.id === original.id).voice, input.voice)
await writeFile(
  path.join(root, "voice-restore-receipt.json"),
  JSON.stringify({
    passed: true,
    encryptedInactiveHops: 2,
    originalStateExact: true,
    historicalStateExact: true,
    activeReconciliationFileCreated: false,
    settlementsResumed: false,
    origin: "strict codec fixture; not a new captured Source export",
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
  }),
)
await finish([])
