import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { admitProfileOperation } from "@opencode-ai/core/kilocode/profile-maintenance"
import { ProfileRoots } from "@opencode-ai/core/kilocode/profile-roots"
import { profileSqlite } from "@opencode-ai/core/kilocode/profile-sqlite"
import { Rpc } from "../../../src/util/rpc"
import { parentStop } from "../../../src/kilocode/cli/cmd/tui/parent-stop"
import * as WorkerIdentity from "../../../src/kilocode/cli/cmd/tui/worker-identity"
import { ProfileParticipants } from "../../../src/kilocode/cli/profile-participants"
import { collect } from "../../../src/kilocode/cli/profile-retirement"
import { retire, receipt } from "../../../src/kilocode/cli/database-retirement"
import { SessionExport } from "../../../src/kilocode/session-export"
import type { rpc } from "./parent-stop-worker"
import { withTimeout } from "../../../src/util/timeout"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"

const dir = process.argv[2]
const baseline = ProfileRoots.snapshot().length
const parent = path.join(dir, "parent.db")
const child = path.join(dir, "tui-child.db")
const exported = path.join(dir, "export-child.db")
const json = { kind: "json" as const, path: path.join(dir, "json") }
const owner = profileSqlite(parent, (file) => new Database(file))
owner.run("CREATE TABLE fixture(value TEXT)")
owner.run("INSERT INTO fixture VALUES ('durable-parent')")
const lease = admitProfileOperation(json)
await fs.mkdir(json.path)
await fs.writeFile(path.join(json.path, "value.json"), '{"value":"durable-json"}')
lease.release()
assert.equal(ProfileRoots.snapshot().length, baseline + 2)

const env = { ...process.env, KILO_RUN_ID: crypto.randomUUID(), [WorkerIdentity.GENERATION]: crypto.randomUUID() }
const request = WorkerIdentity.request(WorkerIdentity.identity(env))
const worker = new Worker(new URL("./parent-stop-worker.ts", import.meta.url).href, { env })
const client = Rpc.client<typeof rpc>(worker)
const ready = Promise.withResolvers<void>()
client.on("ready", () => ready.resolve())
const stop = parentStop({ worker, request, shutdown: () => client.call("shutdown", request), detach: () => undefined })
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused", { status: 503 }) })
const started = Promise.withResolvers<void>()
try {
  await withTimeout(ready.promise, 5_000, "TUI child did not initialize")
  await client.call("init", { file: child, mode: "clean" })
  assert.equal(ProfileParticipants.snapshot().length, 0)
  await stop()
  assert.equal(ProfileParticipants.snapshot().length, 1)
  SessionExport.init({
    agentVersion: "private-participant-union",
    dbPath: exported,
    endpoint: `http://127.0.0.1:${server.port}`,
    workspaceKey: "union",
    syncSeq: () => 0,
    subscribeAll: () => () => undefined,
    createWorker(url) {
      const next = new Worker(url)
      next.addEventListener("message", (event: MessageEvent<{ kind: string }>) => {
        if (event.data.kind === "ready") started.resolve()
      })
      next.addEventListener("error", (event: ErrorEvent) => started.reject(new Error(event.message)))
      return next
    },
  })
  await withTimeout(started.promise, 5_000, "Export child did not initialize")
  await SessionExport.shutdown()
  assert.equal(ProfileParticipants.snapshot().length, 2)
  assert.equal(
    ProfileRoots.snapshot().length,
    baseline + 2,
    "Child roots must come from confirmed observations, not parent realization",
  )
  owner.close()
  await retire()
  assert.equal(receipt()?.roots.length, baseline + 5)
  assert.ok(receipt()?.roots.some((root) => root.kind === "json" && root.path === dir))
  await closeProcessProfile()
  assert.equal(receipt()?.processLocal, true)
  const result = await collect(async (admission) => {
    assert.equal(admission.roots.length, baseline + 5)
    for (const root of admission.roots) {
      assert.throws(() => admitProfileOperation(root), /maintenance/)
      if (root.kind === "sqlite")
        assert.throws(() => profileSqlite(root.path, (file) => new Database(file)), /maintenance/)
    }
    using db = new Database(child, { readonly: true })
    assert.deepEqual(db.query("SELECT value FROM parent_stop ORDER BY rowid").all(), [
      { value: "before" },
      { value: "finalized" },
    ])
    using saved = new Database(parent, { readonly: true })
    assert.deepEqual(saved.query("SELECT value FROM fixture").all(), [{ value: "durable-parent" }])
    assert.deepEqual(await Bun.file(path.join(json.path, "value.json")).json(), { value: "durable-json" })
  })
  assert.equal(result.completeProfileCoverage, false)
  assert.equal(result.portable, false)
  assert.equal(ProfileParticipants.snapshot().length, 2)
  assert.ok(Object.isFrozen(ProfileParticipants.snapshot()))
  console.log(
    JSON.stringify({
      passed: true,
      participants: 2,
      roots: result.roots.length,
      baseline,
      fixtureRoots: 5,
      portable: false,
    }),
  )
} finally {
  owner.close()
  await server.stop(true)
}
