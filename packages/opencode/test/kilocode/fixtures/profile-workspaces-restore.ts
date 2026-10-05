import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { Database as Native } from "bun:sqlite"
import { Effect, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { payload, seal, tables } from "../../../src/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "../../../src/kilocode/migration/profile-restore"
import { historical } from "../../../src/kilocode/migration/profile-evidence"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.argv[2]
assert.ok(root)
const source = path.join(root, "source.db")
const a = path.join(root, "old-workspace")
const b = path.join(a, "sandbox")
const c = path.join(root, "new-workspace")
const d = path.join(root, "new-sandbox")
const e = path.join(root, "final-workspace")
const f = path.join(root, "final-sandbox")
for (const dir of [a, b, c, d, e, f]) await mkdir(dir, { recursive: true })
const runtime = ManagedRuntime.make(Database.layerFromPath(source))
const slash = (value: string) => value.replaceAll("\\", "/")
const text = JSON.stringify({
  type: "text",
  text: `Keep literal source paths ${a} and ${b}`,
  arbitrary: { directory: b },
})
const extra = JSON.stringify({ directory: b, command: "DO_NOT_EXECUTE", opaque: { path: a } })
const schema = await runtime.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql`INSERT INTO project(id,worktree,time_created,time_updated,sandboxes,commands) VALUES ('project',${slash(a)},1,1,${JSON.stringify([slash(b)])},${'{"start":"DO_NOT_EXECUTE"}'})`,
    )
    yield* db.run(
      sql`INSERT INTO workspace(id,type,name,branch,directory,extra,project_id,time_used) VALUES ('workspace','worktree','Imported sandbox','feature/import',${slash(b)},${extra},'project',1)`,
    )
    yield* db.run(
      sql`INSERT INTO project_directory(project_id,directory,type,time_created) VALUES ('project',${slash(path.join(b, "nested"))},'git_worktree',1)`,
    )
    yield* db.run(
      sql`INSERT INTO session(id,project_id,workspace_id,slug,directory,path,title,version,time_created,time_updated) VALUES ('session','project','workspace','session',${slash(path.join(b, "nested"))},'sandbox/nested','Workspace references','1',1,1)`,
    )
    yield* db.run(
      sql`INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES ('message','session',1,1,'{"role":"assistant"}')`,
    )
    yield* db.run(
      sql`INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES ('part','message','session',1,1,${text})`,
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

const value = payload.parse({
  format: "raya.profile-data",
  version: 1,
  id: crypto.randomUUID(),
  createdAt: Date.now(),
  schema,
  workspaces: [a, b],
  sql: rows(source),
  json: [],
  review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
})
const password = "private workspace fixture passphrase"
const bundle = await seal(value, password)
assert.equal(bundle.includes("DO_NOT_EXECUTE"), false)
for (const [name, directory] of [
  ["unknown", path.join(root, "unmapped")],
  ["escape", path.join(a, "..", "outside")],
]) {
  const bad = payload.parse({
    ...value,
    sql: value.sql.map((table) =>
      table.table !== "project"
        ? table
        : {
            ...table,
            rows: table.rows.map((row) =>
              row.map((cell, index) => (table.columns[index] === "sandboxes" ? JSON.stringify([directory]) : cell)),
            ),
          },
    ),
  })
  const target = path.join(root, `refused-${name}`)
  await assert.rejects(restore(await seal(bad, password), password, target, { [a]: c, [b]: d }), /Unmapped/)
  await assert.rejects(stat(target), /ENOENT/)
}
const first = await restore(bundle, password, path.join(root, "first-profile"), { [a]: c, [b]: d })

function check(file: string, main: string, sandbox: string) {
  const db = new Native(file, { readonly: true })
  try {
    assert.deepEqual(db.query("SELECT worktree,sandboxes,commands FROM project").get(), {
      worktree: main,
      sandboxes: JSON.stringify([sandbox]),
      commands: null,
    })
    assert.deepEqual(db.query("SELECT name,branch,directory,extra FROM workspace").get(), {
      name: "Imported sandbox",
      branch: "feature/import",
      directory: sandbox,
      extra: null,
    })
    assert.deepEqual(db.query("SELECT directory FROM project_directory").get(), {
      directory: path.join(sandbox, "nested"),
    })
    assert.deepEqual(db.query("SELECT directory,path FROM session").get(), {
      directory: path.join(sandbox, "nested"),
      path: path.relative(main, path.join(sandbox, "nested")).replaceAll("\\", "/"),
    })
    assert.deepEqual(db.query("SELECT data FROM part").get(), { data: text })
  } finally {
    db.close()
  }
}
check(path.join(first.path, "raya.db"), c, d)
const archives = await historical(first.path)
const next = payload.parse({
  ...value,
  id: crypto.randomUUID(),
  workspaces: [c, d],
  sql: rows(path.join(first.path, "raya.db")),
  archives,
})
const second = await restore(await seal(next, password), password, path.join(root, "second-profile"), {
  [c]: e,
  [d]: f,
})
check(path.join(second.path, "raya.db"), e, f)
const evidence = await historical(second.path)
assert.equal(evidence.length, 2)
assert.equal(evidence.filter((item) => JSON.stringify(item.sql).includes("DO_NOT_EXECUTE")).length, 1)
const archived = evidence[0].sql.find((table) => table.table === "workspace")
assert.ok(archived)
assert.equal(archived.rows[0][archived.columns.indexOf("extra")], extra)
for (const profile of [first, second]) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "profile-workspaces-restart.ts")], {
    env: { ...process.env, ...profile.env },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await writeFile(path.join(profile.path, "restart-stderr.log"), errors)
  assert.equal(code, 0, errors)
  assert.ok(output.includes("WORKSPACE_RESTART_HELD"))
  assert.throws(() => process.kill(child.pid, 0))
  assert.equal(
    JSON.parse(await readFile(path.join(profile.path, "storage/raya/restore-hold.json"), "utf8")).state,
    "held",
  )
}
console.log(
  "WORKSPACE_RESTORE_RECEIPT " +
    JSON.stringify({
      passed: true,
      mapped: 2,
      hops: 2,
      arbitraryTextPreserved: true,
      held: true,
      portableAuthorityClaimed: false,
    }),
)
await finish([])
