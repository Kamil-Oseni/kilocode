import assert from "node:assert/strict"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { payload, seal, tables } from "@/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "@/kilocode/migration/profile-restore"
import { memories } from "@/kilocode/migration/profile-memory"
import { finish } from "@/kilocode/cli/finish"

const root = process.argv[2]
assert(root && path.isAbsolute(root))
const input = payload.parse(JSON.parse(await readFile(path.join(root, "memory-input.json"), "utf8")))
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
assert.equal(original.memory.length, 1)
assert.equal(original.memory[0].quarantine, undefined)
assert.equal(original.memory[0].quarantineLineage, undefined)
const key = "fresh memory inactive encrypted fixture"
const mapping = path.join(root, "mapped-first")
await mkdir(mapping)
const first = await restore(await seal(original, key), key, path.join(root, "first"), {
  [original.memory[0].workspace]: mapping,
})
const values = await memories(path.join(first.path, "memory"), path.join(first.path, "memory"))
assert.equal(values.length, 1)
const next = payload.parse({
  ...original,
  id: crypto.randomUUID(),
  workspaces: [mapping],
  memory: values,
  archives: [Object.fromEntries(Object.entries(original).filter(([key]) => key !== "archives"))],
})
const mapped = path.join(root, "mapped-second")
await mkdir(mapped)
const second = await restore(await seal(next, key), key, path.join(root, "second"), { [mapping]: mapped })
const restored = await memories(path.join(second.path, "memory"), path.join(second.path, "memory"))
assert.equal(restored.length, 1)
for (const value of [values[0], restored[0]]) {
  assert.deepEqual(value.sources, original.memory[0].sources)
  assert.deepEqual(value.sessions, original.memory[0].sessions)
  assert.equal(value.decisions, original.memory[0].decisions)
  assert.equal(value.quarantine, undefined)
  assert.equal(value.quarantineLineage, undefined)
  for (const record of original.memory[0].lineage?.records ?? [])
    assert(value.lineage?.records.some((item) => JSON.stringify(item) === JSON.stringify(record)))
}
for (const [result, workspace] of [
  [first, mapping],
  [second, mapped],
] as const) {
  const id = MemoryPaths.identity({ ctx: { directory: workspace, worktree: workspace } })
  const dir = path.join(result.path, "memory", id.folder)
  assert(!(await readdir(dir)).some((name) => name.startsWith("state.json.bad-")))
  assert.equal(await Bun.file(path.join(dir, "restore-quarantine.json")).exists(), false)
  const state = await MemoryFiles.readState(dir)
  assert.equal(state.enabled, false)
  assert.equal(state.autoConsolidate, false)
  assert.equal(state.capture.turnClose, false)
  assert.equal(state.capture.explicit, false)
  assert.equal(result.reviewed, false)
  assert.equal(
    JSON.parse(await readFile(path.join(result.path, "storage/raya/restore-hold.json"), "utf8")).state,
    "held",
  )
}
await writeFile(
  path.join(root, "memory-restore-receipt.json"),
  JSON.stringify({
    passed: true,
    encryptedInactiveHops: 2,
    exactContentAndSessions: true,
    decisionsNotDuplicated: true,
    quarantineAbsent: true,
    enabled: false,
    consolidation: false,
    capture: false,
    modelsRequested: false,
    replayActivated: false,
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
  }),
)
await finish([])
