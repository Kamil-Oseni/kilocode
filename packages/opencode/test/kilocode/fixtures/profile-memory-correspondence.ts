import assert from "node:assert/strict"
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { payload, seal, tables } from "@/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "@/kilocode/migration/profile-restore"
import { memories } from "@/kilocode/migration/profile-memory"
import { validateMemory } from "@/kilocode/migration/profile-memory-correspondence"
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
const mapping = path.join(root, "mapped-first")
await mkdir(mapping)
const key = "genuine memory inactive encrypted fixture"
const first = await restore(await seal(original, key), key, path.join(root, "first"), {
  [original.memory[0].workspace]: mapping,
})
const firstValue = await memories(path.join(first.path, "memory"), path.join(first.path, "memory"))
assert.equal(firstValue.length, 1)
assert.deepEqual(firstValue[0].sources, original.memory[0].sources)
assert.deepEqual(firstValue[0].sessions, original.memory[0].sessions)
assert.equal(firstValue[0].decisions, original.memory[0].decisions)
assert.deepEqual(firstValue[0].quarantine, original.memory[0].quarantine)
assert.equal(firstValue[0].quarantineLineage?.records.length, 1)
const sidecar = path.join(
  first.path,
  "memory",
  MemoryPaths.declared(firstValue[0].workspace).folder,
  "restore-quarantine.json",
)
const bytes = await readFile(sidecar)
const info = await lstat(sidecar, { bigint: true })
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const claim = {
  kind: "memory-semantic" as const,
  namespace: "primary" as const,
  data: first.path,
  workspace: firstValue[0].workspace,
  componentDigest: hash(JSON.stringify(firstValue[0])),
  selector: { kind: "quarantine-prior" as const },
  source: sidecar,
  dev: String(info.dev),
  ino: String(info.ino),
  bytes: bytes.length,
  digest: hash(bytes),
  rawBytesPreserved: false,
  activation: "inert" as const,
}
validateMemory(claim, { memory: firstValue })
const altered = structuredClone(firstValue)
const entry = altered[0].quarantine![0]
entry.text += " coordinated change"
entry.bytes = Buffer.byteLength(entry.text)
entry.digest = hash(entry.text)
for (const record of altered[0].quarantineLineage!.records)
  for (const reference of record.entries) {
    if (reference.source !== entry.source) continue
    reference.bytes = entry.bytes
    reference.digest = entry.digest
  }
assert.throws(
  () => validateMemory({ ...claim, componentDigest: hash(JSON.stringify(altered[0])) }, { memory: altered }),
  /quarantine history|writer reconstruction/,
)
for (const record of original.memory[0].lineage!.records)
  assert(firstValue[0].lineage!.records.some((item) => JSON.stringify(item) === JSON.stringify(record)))
const next = payload.parse({
  ...original,
  id: crypto.randomUUID(),
  workspaces: [mapping],
  memory: firstValue,
  archives: [Object.fromEntries(Object.entries(original).filter(([key]) => key !== "archives"))],
})
const mapping2 = path.join(root, "mapped-second")
await mkdir(mapping2)
const second = await restore(await seal(next, key), key, path.join(root, "second"), { [mapping]: mapping2 })
const secondValue = await memories(path.join(second.path, "memory"), path.join(second.path, "memory"))
assert.deepEqual(secondValue[0].sources, original.memory[0].sources)
assert.deepEqual(secondValue[0].sessions, original.memory[0].sessions)
assert.equal(secondValue[0].decisions, original.memory[0].decisions)
assert.deepEqual(secondValue[0].quarantine, original.memory[0].quarantine)
assert.equal(secondValue[0].quarantineLineage?.records.length, 2)
assert(!JSON.stringify(secondValue[0].quarantineLineage).includes('"text":'))
for (const record of original.memory[0].lineage!.records)
  assert(secondValue[0].lineage!.records.some((item) => JSON.stringify(item) === JSON.stringify(record)))
for (const [result, workspace] of [
  [first, mapping],
  [second, mapping2],
] as const) {
  const id = MemoryPaths.identity({ ctx: { directory: workspace, worktree: workspace } })
  assert(
    !(await readdir(path.join(result.path, "memory", id.folder))).some((name) => name.startsWith("state.json.bad-")),
  )
  assert(await Bun.file(path.join(result.path, "memory", id.folder, "restore-quarantine.json")).exists())
  const state = await MemoryFiles.readState(path.join(result.path, "memory", id.folder))
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
    originalLineageExact: true,
    exactContentAndSessions: true,
    decisionsNotDuplicated: true,
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
