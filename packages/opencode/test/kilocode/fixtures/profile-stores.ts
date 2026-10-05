import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, copyFile, readFile, writeFile, stat, unlink } from "node:fs/promises"
import { Effect, ManagedRuntime } from "effect"
import { Database as Core } from "@opencode-ai/core/database/database"
import { Database } from "bun:sqlite"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { withWorking, assertWorking } from "../../../src/kilocode/migration/profile-image"
import { classify, collectStores, stores } from "../../../src/kilocode/migration/profile-stores"
import { payload, seal, unseal, tables } from "../../../src/kilocode/migration/profile-bundle"
import { restore } from "../../../src/kilocode/migration/profile-restore"
import { finish } from "../../../src/kilocode/cli/finish"
import { identity } from "../../../src/kilocode/migration/profile-workspaces"

const root = process.argv[2]
const workspace = path.join(root, "workspace")
const external = path.join(root, "additional-workspace")
const data = path.join(root, "offline")
const storage = path.join(data, "storage")
await mkdir(workspace, { recursive: true })
await mkdir(external, { recursive: true })
await mkdir(storage, { recursive: true })
const paths = [path.join(data, "graph0.db"), path.join(data, "graph1.db")]
const runtimes = paths.map((file) => ManagedRuntime.make(Core.layerFromPath(file)))
const quote = (value: string) => value.replaceAll("'", "''")
for (const [index, runtime] of runtimes.entries()) {
  const directory = index === 0 ? workspace : external
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Core.Service).db
      yield* db.run("PRAGMA wal_autocheckpoint=0")
      yield* db.run(
        `INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('project_${index}','${quote(directory)}',1,1,'[]')`,
      )
      yield* db.run(
        `INSERT INTO session(id,project_id,slug,directory,path,title,version,time_created,time_updated,permission,share_url) VALUES ('ses_graph_${index}','project_${index}','graph${index}','${quote(directory)}','','Graph café ${index}','1',1,1,'{"secret":"excluded"}','https://excluded.invalid')`,
      )
    }),
  )
}
const copies = paths
const backups = paths.map((_, index) => path.join(root, `captured${index}.db`))
let wal = 0
for (const [index, file] of paths.entries())
  for (const suffix of ["", "-wal", "-shm"]) {
    await copyFile(file + suffix, backups[index] + suffix)
    if (suffix === "-wal") {
      assert((await stat(file + suffix)).size > 0)
      wal++
    }
  }
await Promise.all(runtimes.map((runtime) => runtime.dispose()))
// Preserve a genuine committed WAL image on the same admitted private roots after closing their owners.
for (const [index, file] of paths.entries())
  for (const suffix of ["", "-wal", "-shm"]) await copyFile(backups[index] + suffix, file + suffix)
const absent = path.join(data, "removed.db")
const retired = ManagedRuntime.make(Core.layerFromPath(absent))
await retired.runPromise(Core.Service)
await retired.dispose()
await unlink(absent)
const helper = path.join(root, "helper", "raya-process-host.exe")
await mkdir(path.dirname(helper))
await copyFile(path.resolve(import.meta.dir, "../../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
const selected = {
  roots: [
    { kind: "sqlite" as const, path: copies[0] },
    { kind: "sqlite" as const, path: copies[1] },
    { kind: "sqlite" as const, path: absent },
    { kind: "json" as const, path: data },
    { kind: "json" as const, path: storage },
  ],
  profile: { database: copies[0], storage, data, preferences: {}, exports: undefined },
}
const policy = { version: 1 as const, directories: [data], files: [] }
const archived = await withImage(
  {
    roots: selected.roots,
    policy,
    helper: {
      executable: helper,
      digest: createHash("sha256")
        .update(await readFile(helper))
        .digest("hex"),
    },
    registry: path.join(root, "registry"),
  },
  (image) =>
    withWorking(image, selected, async (token) => {
      const value = assertWorking(token)
      assert.equal(value.stores.length, 3)
      const result = await collectStores(token, copies[0])
      assert.equal(result.length, 2)
      assert(result.some((store) => store.kind === "absent" && store.source === absent))
      const graph = result.find((store) => store.kind === "raya")!
      assert.equal(graph.kind, "raya")
      if (graph.kind !== "raya") throw new Error("Missing graph")
      assert.deepEqual(graph.workspaces.map(identity), [identity(external)])
      const session = graph.sql.find((table) => table.table === "session")!
      assert.equal(session.rows[0][session.columns.indexOf("id")], "ses_graph_1")
      assert.equal(session.rows[0][session.columns.indexOf("permission")], null)
      assert.equal(session.rows[0][session.columns.indexOf("share_url")], null)
      const main = new Database(value.profile.database, { readonly: true })
      try {
        const sql = tables.map((table) => ({
          table,
          columns: main
            .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
            .all()
            .map((item) => item.name),
          rows: main.query(`SELECT * FROM "${table}"`).values(),
        }))
        const { signature } = await import("../../../src/kilocode/migration/profile-restore")
        const schema = Effect.runSync(
          signature((query) =>
            Effect.sync(() => main.query<{ name: string; type: string; notnull: number; pk: number }, []>(query).all()),
          ),
        )
        return payload.parse({
          format: "raya.profile-data",
          version: 1,
          id: crypto.randomUUID(),
          createdAt: 1,
          schema,
          sql,
          json: [],
          workspaces: [workspace, external],
          stores: result,
          review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
        })
      } finally {
        main.close()
      }
    }),
)
const password = crypto.randomUUID() + crypto.randomUUID()
const text = await seal(archived, password)
const opened = await unseal(text, password)
assert.deepEqual(opened.stores, archived.stores)
const destination = path.join(root, "destination")
const mapped = path.join(root, "mapped")
const additional = path.join(root, "additional-mapped")
await mkdir(mapped)
await mkdir(additional)
const mappings = { [workspace]: mapped, [external]: additional }
const restored = await restore(text, password, destination, mappings)
const evidence = await Bun.file(path.join(restored.path, "restore-stores.json")).json()
assert.equal(evidence.activation, "held")
assert(
  evidence.stores.some((store: { kind: string; source: string }) => store.kind === "absent" && store.source === absent),
)
const preserved = evidence.stores.find((store: { kind: string }) => store.kind === "raya")
assert.deepEqual(preserved.workspaces.map(identity), [identity(additional)])
assert.equal(
  evidence.stores
    .find((store: { kind: string }) => store.kind === "raya")
    .sql.find((table: { table: string }) => table.table === "session").rows[0][0],
  "ses_graph_1",
)
const active = new Database(path.join(restored.path, "raya.db"), { readonly: true })
assert.deepEqual(active.query("SELECT id FROM session").all(), [{ id: "ses_graph_0" }])
active.close()
const historical = { ...opened }
Reflect.deleteProperty(historical, "archives")
const secondtext = await seal({ ...opened, id: crypto.randomUUID(), archives: [historical] }, password)
const second = await restore(secondtext, password, path.join(root, "second-destination"), mappings)
assert.deepEqual(
  (await Bun.file(path.join(second.path, "restore-source.json")).json()).archives[0].stores,
  opened.stores,
)
const unknown = path.join(root, "unknown.db")
const native = new Database(unknown)
native.exec("CREATE TABLE unknown(value TEXT)")
native.close()
await assert.rejects(classify(unknown), /unsupported full schema/)
const extra = path.join(root, "extra.db")
await copyFile(path.join(restored.path, "raya.db"), extra)
const altered = new Database(extra)
altered.exec("CREATE TRIGGER unsupported AFTER INSERT ON session BEGIN SELECT 1; END")
altered.close()
await assert.rejects(classify(extra), /unsupported full schema/)
const index = path.join(root, "index.db")
await copyFile(path.join(restored.path, "raya.db"), index)
const indexed = new Database(index)
indexed.exec("CREATE INDEX unshipped_index ON session(title)")
indexed.close()
await assert.rejects(classify(index), /unsupported full schema/)
assert.throws(() => stores.parse([{ ...opened.stores!.find((store) => store.kind === "raya"), sql: [] }]))
await writeFile(
  path.join(root, "receipt.json"),
  JSON.stringify({
    passed: true,
    graphs: 2,
    walCopies: wal,
    additionalStores: 1,
    absenceObserved: true,
    distinctWorkspaceRefs: 2,
    primarySeparate: true,
    credentialsExcluded: true,
    inactive: true,
    twoHop: true,
    unknownSchemaRefused: true,
    triggerRefused: true,
    indexRefused: true,
    sourceCaptureAuthority: false,
    qualification:
      "Two actual distinct Core graphs; offline raw WAL copy fixture and codec encryption do not claim full source handoff authority.",
    portableCaptureAuthorized: false,
  }),
)
await finish([])
