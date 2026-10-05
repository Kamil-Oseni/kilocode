import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { Database as Native } from "bun:sqlite"
import { Effect, ManagedRuntime } from "effect"
import { Global } from "@opencode-ai/core/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { seal, tables, payload } from "../../../src/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "../../../src/kilocode/migration/profile-restore"
import { hold } from "../../../src/kilocode/task/hold"
import { Storage } from "../../../src/storage/storage"
import { scheduler } from "../../../src/kilocode/task/scheduler"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { Memory } from "@kilocode/kilo-memory/memory"
import { memories } from "../../../src/kilocode/migration/profile-memory"
import { historical } from "../../../src/kilocode/migration/profile-evidence"
import { selected } from "../../../src/kilocode/migration/profile-preference-files"
import { held as host } from "../../../src/kilocode/migration/profile-host"

const root = process.argv[2]
assert.ok(root)
const source = path.join(root, "source")
const workspace = path.join(root, "old-workspace")
const declared = workspace.replaceAll("\\", "/")
const mapped = path.join(root, "new-workspace")
await mkdir(source)
await mkdir(workspace)
await mkdir(mapped)
const runtime = ManagedRuntime.make(Database.layerFromPath(path.join(source, "raya.db")))
const schema = await runtime.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      `INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('project','${declared.replaceAll("'", "''")}',1,1,'[]')`,
    )
    yield* db.run(
      `INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,permission,share_url) VALUES ('session','project','session','${declared.replaceAll("'", "''")}','Encrypted restore fixture','1',1,1,'[{"permission":"*","action":"allow","pattern":"*"}]','https://fixture.invalid/share-token')`,
    )
    yield* db.run(
      `INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES ('message','session',1,1,'{"role":"assistant"}')`,
    )
    yield* db.run(
      `INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES ('part','message','session',1,1,'{"type":"text","text":"DURABLE_ENCRYPTED_MARKER"}')`,
    )
    yield* db.run(
      `INSERT INTO raya_routine_occurrence(id,agent_id,schedule_version,scheduled_at,observed_at,state,claim_id,owner,lease_until,time_updated) VALUES ('overdue','agent',1,1,1,'queued','source-claim','source-owner',9999999999999,1)`,
    )
    yield* db.run(
      `INSERT INTO raya_contact_destination(id,source,channel,address,scope,scope_id,revision,enabled,time_created,time_updated) VALUES ('destination','fixture','email','fixture@example.invalid','agent','agent',1,1,1,1)`,
    )
    yield* db.run(
      `INSERT INTO raya_contact_message(id,source,destination_id,destination_revision,body,state,attempts,available_at,lease_id,lease_owner,lease_until,time_created,time_updated) VALUES ('uncertain-message','fixture','destination',1,'UNCERTAIN_SEND','leased',1,1,'source-send-lease','source-owner',9999999999999,1,1)`,
    )
    yield* db.run(
      `INSERT INTO raya_contact_message(id,source,destination_id,destination_revision,body,state,attempts,available_at,time_created,time_updated) VALUES ('delivered-message','fixture-delivered','destination',1,'HISTORICAL_DELIVERY','delivered',1,1,1,1)`,
    )
    yield* db.run(
      `INSERT INTO raya_contact_receipt(message_id,status,code,provider_ref,attempts,time_created) VALUES ('delivered-message','delivered','source-verified','original-provider-receipt',1,1)`,
    )
    return yield* signature((query) => db.all<Column>(query))
  }),
)
await runtime.dispose()
const db = new Native(path.join(source, "raya.db"), { readonly: true })
const data = (() => {
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
})()
const identity = MemoryPaths.identity({ ctx: { directory: workspace, worktree: workspace } })
const memory = path.join(source, "memory", identity.folder)
await Memory.enable({ root: memory, id: identity })
await MemoryFiles.writeSource(
  memory,
  "project.md",
  "# Project Memory\n\n## Facts\n- architecture :: PERSONAL_MEMORY_MARKER\n",
)
await MemoryFiles.writeSession(memory, {
  sessionID: "memory-session",
  summary: "SESSION_MEMORY_MARKER",
  max: 4000,
  time: 1000,
})
await writeFile(MemoryPaths.files(memory).decisions, '{"decision":"HISTORICAL_MEMORY_DECISION"}\n')
const captured = await memories(path.join(source, "memory"))
assert.equal(captured.length, 1)
assert.equal(captured[0].workspace, workspace)
const config = path.join(source, "config")
await mkdir(config)
const files = {
  config: path.join(config, "kilo.jsonc"),
  modelState: path.join(config, "model.json"),
  extensionState: path.join(config, "selected-client.json"),
}
await writeFile(
  files.config,
  '{// selected safe preferences\n"model":"qwen-local/qwen3:8b","default_agent":"auto","provider":{"private":{"apiKey":"SYNTHETIC_PRIVATE_CREDENTIAL"}},"permission":"allow"}',
)
await writeFile(files.modelState, '{"model":{"auto":{"providerID":"qwen-local","modelID":"qwen3:8b"}}}')
await writeFile(
  files.extensionState,
  '{"favoriteModels":[{"providerID":"qwen-local","modelID":"qwen3:8b"}],"apiKey":"SYNTHETIC_PRIVATE_CREDENTIAL"}',
)
await assert.rejects(selected(files, []), /outside/)
const preferences = await selected(files, [{ kind: "json", path: config }])
assert.equal(JSON.stringify(preferences).includes("SYNTHETIC_PRIVATE_CREDENTIAL"), false)
const value = payload.parse({
  format: "raya.profile-data",
  version: 1,
  id: crypto.randomUUID(),
  createdAt: Date.now(),
  schema,
  workspaces: [declared],
  memory: captured,
  preferences,
  host: {
    format: "raya.host-capsule",
    version: 1,
    hosts: [
      {
        id: crypto.randomUUID(),
        role: "view",
        revision: 3,
        models: {
          selected: { providerID: "qwen-local", modelID: "qwen3:8b" },
          recent: [],
          favorite: [{ providerID: "qwen-local", modelID: "qwen3:8b" }],
          agents: [],
        },
        owners: [],
        contexts: [{ id: crypto.randomUUID(), path: workspace }],
      },
    ],
  },
  sql: data,
  json: [
    {
      path: "raya/goal/session.json",
      value: JSON.stringify({
        status: "active",
        objective: "PERSISTENT_GOAL",
        createdAt: 1,
        updatedAt: 1,
        usage: { turns: 1, continuations: 0, toolCalls: 0, cost: 4 },
        progress: [],
      }),
    },
    {
      path: "raya/agent-runs/agent.json",
      value: JSON.stringify({
        version: 1,
        cursor: 3,
        runs: ["complete", "error", "running"].map((status, index) => ({
          id: `source-${status}`,
          agentID: "agent",
          at: index + 1,
          sessionID: "ses_historyfixture",
          status,
          revision: 1,
        })),
        events: ["complete", "error", "running"].map((status, index) => ({
          version: 1,
          id: `agent:${index + 1}`,
          stream: "agent",
          sequence: index + 1,
          kind: "run.changed",
          visibility: "workspace",
          runID: `source-${status}`,
          agentID: "agent",
          sessionID: "ses_historyfixture",
          stateRevision: 1,
          status,
          at: index + 1,
        })),
      }),
    },
    {
      path: "raya/agent.json",
      value: JSON.stringify([
        {
          id: "agent",
          name: "Restored fixture",
          role: "generalist",
          objective: "Never automatically replay imported work",
          capabilities: [],
          memoryScope: "role",
          schedule: { kind: "once", at: 1 },
          scheduleVersion: 1,
          scheduleUpdatedAt: 1,
          enabled: true,
          execution: { state: "active", runID: "source-run" },
          dir: workspace,
          tools: ["bash"],
          access: "full",
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    },
  ],
  review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
})
const bundle = await seal(value, "private isolated fixture passphrase")
assert.equal(bundle.includes("DURABLE_ENCRYPTED_MARKER"), false)
for (const version of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
  const invalid = {
    ...value,
    json: value.json.map((item) =>
      item.path === "raya/agent.json"
        ? {
            ...item,
            value: JSON.stringify(
              JSON.parse(item.value).map((agent: Record<string, unknown>) => ({ ...agent, scheduleVersion: version })),
            ),
          }
        : item,
    ),
  }
  const encrypted = await seal(invalid, "private isolated fixture passphrase")
  const destination = path.join(root, `version-refused-${version}`)
  await assert.rejects(
    restore(encrypted, "private isolated fixture passphrase", destination, { [declared]: mapped }),
    /version|safe|integer/i,
  )
  await assert.rejects(stat(destination), /ENOENT/)
}
const target = path.join(root, "destination")
const result = await restore(bundle, "private isolated fixture passphrase", target, { [declared]: mapped })
assert.equal(value.memory[0].workspace, workspace)
assert.equal(value.workspaces[0], declared)
assert.deepEqual(await host(result.path), value.host)
assert.equal(result.reviewed, false)
assert.equal(result.uncertainWork, "held-no-replay")
const restored = new Native(path.join(result.path, "raya.db"), { readonly: true })
try {
  assert.equal(restored.query<{ directory: string }, []>("SELECT directory FROM session").get()?.directory, mapped)
  assert.equal(restored.query<{ worktree: string }, []>("SELECT worktree FROM project").get()?.worktree, mapped)
  assert.deepEqual(restored.query("SELECT permission,share_url FROM session").get(), {
    permission: null,
    share_url: null,
  })
  assert.ok(JSON.stringify(restored.query("SELECT data FROM part").get()).includes("DURABLE_ENCRYPTED_MARKER"))
  assert.equal(restored.query<{ count: number }, []>("SELECT count(*) AS count FROM credential").get()?.count, 0)
  assert.equal(
    restored.query<{ count: number }, []>("SELECT count(*) AS count FROM raya_routine_occurrence").get()?.count,
    0,
  )
  assert.deepEqual(restored.query("SELECT id,state FROM raya_contact_message").all(), [
    { id: "delivered-message", state: "delivered" },
  ])
  assert.deepEqual(restored.query("SELECT message_id,status,provider_ref FROM raya_contact_receipt").all(), [
    { message_id: "delivered-message", status: "delivered", provider_ref: "original-provider-receipt" },
  ])
  assert.deepEqual(restored.query("SELECT enabled FROM raya_contact_destination").get(), { enabled: 0 })
} finally {
  restored.close()
}
const held = JSON.parse(await readFile(path.join(result.path, "storage/raya/restore-hold.json"), "utf8"))
assert.equal(held.state, "held")
assert.equal(held.id, result.hold)
Global.Path.data = result.path
const storage = ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([Storage.node])))
const store = await storage.runPromise(Storage.Service)
async function restart(mode: string, selected = result) {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "profile-restored-restart.ts"), selected.path, mode],
    {
      env: { ...process.env, ...selected.env },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const timer = setTimeout(() => child.kill(), 10_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  assert.equal(code, 0, stderr)
  assert.ok(stdout.includes('"replayed":false'))
  assert.throws(() => process.kill(child.pid, 0))
}
// The production admission guard consumes the exact durable destination hold.
await assert.rejects(storage.runPromise(hold(store).check()), /paused|transferred profile/)
await restart("held")
await storage.runPromise(hold(store).release(held.id, { reviewed: true }))
await storage.runPromise(hold(store).check())
await restart("reviewed")
const agents = await storage.runPromise(
  store.read<{ enabled: boolean; scheduleVersion: number; execution?: unknown; tools: string[] }[]>(["raya", "agent"]),
)
assert.equal(agents[0].enabled, false)
assert.equal(agents[0].scheduleVersion, 2)
assert.equal(agents[0].execution, undefined)
assert.deepEqual(agents[0].tools, [])
const restarted = ManagedRuntime.make(Database.layerFromPath(path.join(result.path, "raya.db")))
const database = await restarted.runPromise(Database.Service)
assert.equal(
  await restarted.runPromise(scheduler({ database, storage: store }).prepare("agent", Date.now())),
  undefined,
)
assert.deepEqual(await restarted.runPromise(database.db.all("SELECT id FROM raya_routine_occurrence")), [])
await restarted.dispose()
await storage.dispose()
assert.equal(
  JSON.parse(await readFile(path.join(result.path, "storage/raya/goal/session.json"), "utf8")).objective,
  "PERSISTENT_GOAL",
)
assert.equal(
  JSON.parse(await readFile(path.join(result.path, "storage/raya/goal/session.json"), "utf8")).status,
  "paused",
)
assert.equal(JSON.parse(await readFile(path.join(result.path, "storage/raya/goal/session.json"), "utf8")).usage.cost, 4)
await assert.rejects(restore(bundle, "private isolated fixture passphrase", target, { [declared]: mapped }), /EEXIST/)
const malformed = await seal({ ...value, schema: "0".repeat(64) }, "private isolated fixture passphrase")
const rejected = path.join(root, "schema-refused")
await assert.rejects(
  restore(malformed, "private isolated fixture passphrase", rejected, { [declared]: mapped }),
  /Restore refused/,
)
await assert.rejects(stat(path.join(rejected, "data/kilo")), /ENOENT/)
assert.equal(
  JSON.parse(await readFile(path.join(rejected, ".pending/storage/raya/restore-hold.json"), "utf8")).state,
  "held",
)
assert.ok((await readFile(path.join(result.path, "restore-source.json"), "utf8")).includes("source-claim"))
assert.ok((await readFile(path.join(result.path, "restore-source.json"), "utf8")).includes("source-send-lease"))
// The second transfer reads actual restored files/SQLite. Historical source rows remain evidence only.
const archives = await historical(result.path)
assert.deepEqual(
  archives.map((item) => item.id),
  [value.id],
)
const second = new Native(path.join(result.path, "raya.db"), { readonly: true })
const rows = (() => {
  try {
    return tables.map((table) => ({
      table,
      columns: second
        .query<Column, []>(`PRAGMA table_info('${table}')`)
        .all()
        .map((column) => column.name),
      rows: second.query(`SELECT * FROM "${table}"`).values(),
    }))
  } finally {
    second.close()
  }
})()
const retained = await memories(path.join(result.path, "memory"))
assert.equal(retained[0].decisions.match(/HISTORICAL_MEMORY_DECISION/g)?.length, 1)
const next = payload.parse({
  ...value,
  id: crypto.randomUUID(),
  workspaces: [mapped],
  sql: rows,
  memory: retained,
  archives,
  host: await host(result.path),
  json: await Promise.all(
    value.json.map(async (item) => ({
      ...item,
      value: await readFile(path.join(result.path, "storage", ...item.path.split("/")), "utf8"),
    })),
  ),
})
const remapped = path.join(root, "third-workspace")
await mkdir(remapped)
const encrypted = await seal(next, "private isolated fixture passphrase")
assert.equal(encrypted.includes("source-send-lease"), false)
const transferred = await restore(
  encrypted,
  "private isolated fixture passphrase",
  path.join(root, "second-destination"),
  { [mapped]: remapped },
)
await restart("held", transferred)
assert.deepEqual(await host(transferred.path), value.host)
Global.Path.data = transferred.path
const reviewed = ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([Storage.node])))
const destination = await reviewed.runPromise(Storage.Service)
await reviewed.runPromise(hold(destination).release(transferred.hold, { reviewed: true }))
await reviewed.dispose()
await restart("reviewed", transferred)
const final = new Native(path.join(transferred.path, "raya.db"), { readonly: true })
try {
  assert.equal(final.query<{ total: number }, []>("SELECT count(*) total FROM message").get()?.total, 1)
  assert.equal(final.query<{ total: number }, []>("SELECT count(*) total FROM part").get()?.total, 1)
  assert.deepEqual(final.query("SELECT id,state FROM raya_contact_message").all(), [
    { id: "delivered-message", state: "delivered" },
  ])
  assert.deepEqual(final.query("SELECT id FROM raya_routine_occurrence").all(), [])
} finally {
  final.close()
}
const evidence = await historical(transferred.path)
assert.deepEqual(
  evidence.map((item) => item.id),
  [value.id, next.id],
)
assert.equal(evidence.filter((item) => JSON.stringify(item).includes("source-send-lease")).length, 1)
assert.equal(evidence.filter((item) => JSON.stringify(item).includes("source-claim")).length, 1)
assert.equal(
  (await memories(path.join(transferred.path, "memory")))[0].decisions.match(/HISTORICAL_MEMORY_DECISION/g)?.length,
  1,
)
console.log(
  "BUNDLE_RESTORE_RECEIPT " +
    JSON.stringify({
      passed: true,
      schema,
      path: result.path,
      held: true,
      remapped: true,
      credentials: 0,
      hostTwoHop: true,
      portableAuthorityClaimed: false,
    }),
)
