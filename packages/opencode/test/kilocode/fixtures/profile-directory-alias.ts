import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { Database as Native } from "bun:sqlite"
import { Effect, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { payload, seal, tables, snapshot } from "../../../src/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "../../../src/kilocode/migration/profile-restore"
import { finish } from "../../../src/kilocode/cli/finish"
const root = process.argv[2]
assert(root)
const source = path.join(root, "source.db"),
  old = path.join(root, "old"),
  first = path.join(root, "mapped"),
  last = path.join(root, "final")
for (const dir of [old, first, last]) await mkdir(dir, { recursive: true })
const runtime = ManagedRuntime.make(Database.layerFromPath(source))
const schema = await runtime.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql`INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('logical-project',${old},1,1,'[]')`,
    )
    yield* db.run(
      sql`INSERT INTO project_directory(project_id,directory,type,strategy,time_created) VALUES ('logical-project',${old},'main',NULL,20)`,
    )
    yield* db.run(
      sql`INSERT INTO project_directory(project_id,directory,type,strategy,time_created) VALUES ('logical-project',${old.replaceAll("\\", "/")},'main',NULL,10)`,
    )
    yield* db.run(
      sql`INSERT INTO session(id,project_id,slug,directory,path,title,version,time_created,time_updated) VALUES ('session','logical-project','session',${old},'','Aliases café 日本語 😀','1',1,1)`,
    )
    return yield* signature((query) => db.all<Column>(query))
  }),
)
await runtime.dispose()
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
const original = payload.parse({
  format: "raya.profile-data",
  version: 1,
  id: crypto.randomUUID(),
  createdAt: Date.now(),
  schema,
  workspaces: [old],
  sql: rows(source),
  json: [],
  review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
})
const secret = crypto.randomUUID()
const envelope = await seal(original, secret)
const a = await restore(envelope, secret, path.join(root, "first"), { [old]: first })
function check(file: string, dir: string) {
  const db = new Native(file, { readonly: true })
  try {
    assert.deepEqual(db.query("SELECT project_id,directory,type,strategy,time_created FROM project_directory").all(), [
      { project_id: "logical-project", directory: dir, type: "main", strategy: null, time_created: 10 },
    ])
    assert.equal(
      db.query<{ project_id: string }, []>("SELECT project_id FROM session").get()?.project_id,
      "logical-project",
    )
    assert.equal(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM session_input").get()?.n, 0)
  } finally {
    db.close()
  }
}
check(path.join(a.path, "raya.db"), first)
const retained = JSON.parse(await readFile(path.join(a.path, "restore-source.json"), "utf8"))
assert.deepEqual(retained.sql, original.sql)
const native = new Native(path.join(a.path, "raya.db"))
try {
  native
    .query(
      "INSERT INTO project_directory(project_id,directory,type,strategy,time_created) VALUES ('logical-project',?,'main',NULL,30)",
    )
    .run(first.replaceAll("\\", "/"))
} finally {
  native.close()
}
const second = payload.parse({
  ...original,
  id: crypto.randomUUID(),
  workspaces: [first],
  sql: rows(path.join(a.path, "raya.db")),
  archives: [snapshot.parse(Object.fromEntries(Object.entries(original).filter(([key]) => key !== "archives")))],
})
const b = await restore(await seal(second, secret), secret, path.join(root, "second"), { [first]: last })
check(path.join(b.path, "raya.db"), last)
const archived = JSON.parse(await readFile(path.join(b.path, "restore-source.json"), "utf8"))
assert.deepEqual(archived.archives[0].sql, original.sql)
assert.deepEqual(archived.sql, second.sql)
assert.equal(original.sql.find((table) => table.table === "project_directory")?.rows.length, 2)
await writeFile(
  path.join(root, "receipt.json"),
  JSON.stringify({
    ok: true,
    sourceNativeAliasRows: 2,
    encryptedHops: 2,
    destinationRows: 1,
    earliestCreation: 10,
    logicalProjectPreserved: true,
    originalRowsAndTimestampsInert: true,
    held: true,
    compiledWriter: false,
    portable: false,
  }),
  { flag: "wx" },
)
console.log("ALIAS_RESTORE_PASSED")
await finish([])
