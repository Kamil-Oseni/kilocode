import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Database as Native } from "bun:sqlite"
import { Effect, Layer } from "effect"
import { sql as query } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import { composerRetention } from "@/kilocode/session/composer-retention"
import { DraftLegacy, type DraftContent } from "@/kilocode/session/composer-codec"
import { payload, seal, tables } from "@/kilocode/migration/profile-bundle"
import { collectComposers } from "@/kilocode/migration/profile-composers"
import { restore, signature, type Column } from "@/kilocode/migration/profile-restore"
import { finish } from "@/kilocode/cli/finish"

const root = process.argv[2]
assert.ok(root)
const source = path.join(root, "source")
const old = path.join(root, "original-workspace")
const mapped = path.join(root, "mapped-workspace")
const final = path.join(root, "final-workspace")
for (const dir of [source, old, mapped, final]) await mkdir(dir, { recursive: true })
const identity = {
  key: "sidebar:new-task:pending:actual",
  box: "sidebar:new-task",
  workspace: old,
  projectID: "6f8486f4b90d1fcdad44ea38ba2e2c60f4f89cb8",
  pendingID: "actual",
}
const content: DraftContent = {
  text: "UNSENT café 日本語 😀",
  comments: [],
  images: [],
  scroll: 7,
  selection: { start: 2, end: 5 },
  model: { providerID: "local", modelID: "qwen" },
  agent: "auto",
}
function run<A, E>(
  dir: string,
  body: (drafts: ReturnType<typeof composerRetention>, database: Database.Interface) => Effect.Effect<A, E>,
) {
  const storage = path.join(dir, "storage")
  const file = path.join(dir, "raya.db")
  const layer = Layer.mergeAll(Storage.layerFromDir(storage), Database.layerFromPath(file)).pipe(
    Layer.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Storage.Service
      const database = yield* Database.Service
      return yield* body(composerRetention(database, store, storage, file), database)
    }).pipe(Effect.provide(layer)),
  )
}
const saved = await run(source, (drafts) => drafts.save(identity, undefined, content, "original-mutation"))
const session = {
  ...identity,
  key: "sidebar:new-task:session:restored",
  pendingID: undefined,
  sessionID: "ses_f05b23418ffeEQa07t2IfPD0iw",
}
const retained = await run(source, (drafts) =>
  drafts.save(session, undefined, { ...content, text: content.text + " session" }, "original-session-mutation"),
)
await writeFile(path.join(root, "expected.json"), JSON.stringify({ pending: saved, session: retained }))
await run(source, (_, database) =>
  Effect.gen(function* () {
    yield* database.db.run(
      query`INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('6f8486f4b90d1fcdad44ea38ba2e2c60f4f89cb8',${old},1,1,'[]')`,
    )
    yield* database.db.run(
      query`INSERT INTO session(id,project_id,slug,directory,path,title,version,time_created,time_updated) VALUES ('ses_f05b23418ffeEQa07t2IfPD0iw','6f8486f4b90d1fcdad44ea38ba2e2c60f4f89cb8','restored',${old},'','Imported retained chat','1',1,1)`,
    )
  }),
)
const schema = await run(source, (_, database) => signature((query) => database.db.all<Column>(query)))
function sql(dir: string) {
  const db = new Native(path.join(dir, "raya.db"), { readonly: true })
  try {
    return payload.shape.sql.parse(
      tables.map((table) => ({
        table,
        columns: db
          .query<Column, []>(`PRAGMA table_info('${table}')`)
          .all()
          .map((column) => column.name),
        rows: db.query(`SELECT * FROM "${table}"`).values(),
      })),
    )
  } finally {
    db.close()
  }
}
const original = sql(source)
const composers = await collectComposers(original, path.join(source, "storage"))
assert.ok(composers)
const value = payload.parse({
  format: "raya.profile-data",
  version: 1,
  id: crypto.randomUUID(),
  createdAt: Date.now(),
  schema,
  workspaces: [old],
  sql: original,
  json: [],
  composers,
  review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
})
const password = "synthetic private composer fixture passphrase"
const first = await restore(await seal(value, password), password, path.join(root, "first"), { [old]: mapped })
assert.equal(sql(first.path).find((item) => item.table === "raya_composer_control")?.rows.length, 0)
assert.equal(sql(first.path).find((item) => item.table === "raya_composer_draft")?.rows.length, 0)
const legacy = await collectComposers(sql(first.path), path.join(first.path, "storage"))
assert.ok(legacy)
assert.equal(legacy.entries[0].identity.workspace, mapped)
assert.equal(legacy.entries[0].receipt, undefined)
assert.deepEqual(legacy.entries[0].token, saved.token)
assert.deepEqual(legacy.entries[0].content, content)
const archived = JSON.parse(await readFile(path.join(first.path, "restore-source.json"), "utf8"))
assert.deepEqual(archived.sql, value.sql)
// A second encrypted import before any UI mount must collect genuine legacy content, not drop it.
const second = await restore(
  await seal(
    payload.parse({ ...value, id: crypto.randomUUID(), workspaces: [mapped], sql: sql(first.path), composers: legacy }),
    password,
  ),
  password,
  path.join(root, "second"),
  { [mapped]: final },
)
for (const mode of ["edit", "reopen", "reopen-cli"]) {
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "profile-composers-http.ts"),
      final,
      path.join(root, "expected.json"),
      mode,
    ],
    {
      env: {
        ...process.env,
        ...second.env,
        KILO_PLATFORM: mode === "reopen-cli" ? "cli" : "vscode",
        KILO_CONFIG_CONTENT: '{"enabled_providers":[]}',
      },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const state = { forced: false }
  const timer = setTimeout(() => {
    state.forced = true
    child.kill()
  }, 30_000)
  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  await writeFile(path.join(root, `http-${mode}-stderr.log`), errors)
  await writeFile(path.join(root, `http-${mode}-stdout.log`), output)
  await writeFile(path.join(root, `http-${mode}-exit.json`), JSON.stringify({ pid: child.pid, code, ...state }))
  assert.equal(state.forced, false, `HTTP ${mode} exceeded its deadline`)
  assert.equal(code, 0, errors)
  assert.ok(output.includes("COMPOSER_HISTORY_HTTP_PASS"))
  assert.throws(() => process.kill(child.pid, 0))
}
const control = sql(second.path).find((item) => item.table === "raya_composer_control")
const prior = original.find((item) => item.table === "raya_composer_control")
assert.ok(control && prior)
for (const key of ["storage", "database", "generation", "cursor_secret"])
  assert.notEqual(control.rows[0][control.columns.indexOf(key)], prior.rows[0][prior.columns.indexOf(key)])
assert.deepEqual(sql(source), original)
assert.equal(
  DraftLegacy.checked(JSON.parse(await readFile(path.join(first.path, "storage/raya/composer-drafts.json"), "utf8")))
    .entries.length,
  2,
)
await writeFile(
  path.join(root, "receipt.json"),
  JSON.stringify({
    ok: true,
    encryptedHops: 2,
    realBoot: true,
    catalog: 1,
    editAndReopen: true,
    sourceUnchanged: true,
    copiedRootAuthority: false,
  }),
)
console.log("COMPOSER_RESTORE_PASS")
await finish([])
