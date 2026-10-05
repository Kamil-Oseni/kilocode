import assert from "node:assert/strict"
import path from "node:path"
import { Database as Native } from "bun:sqlite"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Storage } from "../../../src/kilocode/session-export/worker/storage"
import { Chunker } from "../../../src/kilocode/session-export/worker/chunks"
import { evidence } from "../../../src/kilocode/migration/profile-exports"
import { payload, seal, tables } from "../../../src/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "../../../src/kilocode/migration/profile-restore"
import { historical } from "../../../src/kilocode/migration/profile-evidence"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.argv[2]
assert.ok(root)
const runtime = ManagedRuntime.make(Database.layerFromPath(path.join(root, "source.db")))
const schema = await runtime.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* signature((query) => db.all<Column>(query))
  }),
)
await runtime.dispose()
const file = path.join(root, "session-export.db")
const storage = new Storage(file)
storage.migrate()
const ids = await new Chunker(storage, { chunkBytes: 100_000 }).write(Buffer.from("Private export archive — 日本語 😀"))
storage.insertEvent({
  id: crypto.randomUUID(),
  schemaVersion: 1,
  sessionId: "private-session",
  rootSessionId: "private-session",
  seq: 1,
  type: "tool_executed",
  ts: Date.now(),
  agentVersion: "fixture",
  clientScrubbed: 1,
  dataJson: JSON.stringify({ outputChunkIds: ids, arbitrary: { directory: "C:/old/path" } }),
})
storage.close()
const exports = await evidence(file)
assert.ok(exports)
function rows(file: string) {
  const db = new Native(file, { readonly: true })
  try {
    return tables.map((table) => ({
      table,
      columns: db
        .query<Column, []>(`PRAGMA table_info('${table}')`)
        .all()
        .map((column) => column.name),
      rows: db.query(`SELECT * FROM "${table}"`).values(),
    }))
  } finally {
    db.close()
  }
}
const value = payload.parse({
  format: "raya.profile-data",
  version: 1,
  id: crypto.randomUUID(),
  createdAt: Date.now(),
  schema,
  workspaces: [],
  sql: rows(path.join(root, "source.db")),
  json: [],
  exports,
  review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
})
const password = "private archive native fixture passphrase"
const first = await restore(await seal(value, password), password, path.join(root, "first"), {})
assert.deepEqual(await Bun.file(path.join(first.path, "restore-exports.json")).json(), exports)
assert.equal(await Bun.file(path.join(first.path, "session-export.db")).exists(), false)
const archives = await historical(first.path)
assert.deepEqual(archives[0].exports, exports)
const next = payload.parse({
  ...value,
  id: crypto.randomUUID(),
  sql: rows(path.join(first.path, "raya.db")),
  exports: undefined,
  archives,
})
const second = await restore(await seal(next, password), password, path.join(root, "second"), {})
assert.equal(await Bun.file(path.join(second.path, "session-export.db")).exists(), false)
assert.equal(await Bun.file(path.join(second.path, "restore-exports.json")).exists(), false)
const old = await historical(second.path)
assert.equal(old.length, 2)
assert.deepEqual(old.find((row) => row.id === value.id)?.exports, exports)
assert.equal(await Bun.file(path.join(second.path, "storage/raya/restore-hold.json")).exists(), true)
console.log(
  JSON.stringify({
    ok: true,
    hops: 2,
    artifactHistoryPreserved: true,
    activeUploaderDatabaseAbsent: true,
    portable: false,
  }),
)
await finish([])
