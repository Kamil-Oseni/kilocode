import assert from "node:assert/strict"
import path from "node:path"
import { readFile, realpath, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { withImage, assertImage, type Image } from "@opencode-ai/core/kilocode/source-offline"
import { Rpc } from "../../../src/util/rpc"
import { parentStop } from "../../../src/kilocode/cli/cmd/tui/parent-stop"
import * as Tui from "../../../src/kilocode/cli/cmd/tui/worker-identity"
import * as Export from "../../../src/kilocode/session-export/worker-identity"
import { stopExportWorker } from "../../../src/kilocode/session-export/worker-stop"
import * as Index from "../../../src/kilocode/indexing-retirement"
import { ProfileParticipants, participantScopes, participants } from "../../../src/kilocode/cli/profile-participants"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { observation } from "../../../src/kilocode/cli/profile-retirement"
import { stateScopes } from "../../../src/kilocode/migration/profile-scope"
import { workerScopes } from "../../../src/kilocode/cli/worker-scopes"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.argv[2]
const url = new URL("./worker-state-role.ts", import.meta.url).href
for (const mode of ["tui", "export", "index"]) {
  const state = path.join(root, `${mode}-state`)
  const env = {
    ...process.env,
    RAYA_ROLE_MODE: mode,
    RAYA_ROLE_STATE: state,
    KILO_RUN_ID: crypto.randomUUID(),
    [Tui.GENERATION]: crypto.randomUUID(),
    [Index.RUN]: crypto.randomUUID(),
    [Index.GENERATION]: crypto.randomUUID(),
  }
  const worker = new Worker(url, { env })
  const ready = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<void>()
  worker.addEventListener("message", (event) => {
    if (event.data?.roleReady) ready.resolve()
  })
  worker.addEventListener("error", (event) => ready.reject(event.error ?? new Error(event.message)))
  worker.addEventListener("close", (event) => {
    if (!("code" in event) || event.code !== 0 || !("wasClean" in event) || event.wasClean !== true)
      return exited.reject(new Error("Worker clean exit missing"))
    exited.resolve()
  })
  try {
    await ready.promise
    if (mode === "tui") {
      const request = Tui.request(Tui.identity(env))
      const client = Rpc.client<{ shutdown: (input: typeof request) => Promise<unknown> }>(worker)
      const reply = await parentStop({
        worker,
        request,
        shutdown: () => client.call("shutdown", request),
        detach: () => undefined,
      })()
      assert.throws(() => Tui.validate({ ...reply, scopes: { version: 1, states: [`${root}-outside`] } }, request))
      assert.throws(() => Tui.validate({ ...reply, requestID: crypto.randomUUID() }, request))
      assert.equal(Tui.validate({ ...reply, scopes: undefined }, request).scopes, undefined)
    }
    if (mode === "export") {
      const owner = Export.spawn(crypto.randomUUID())
      const started = Promise.withResolvers<void>()
      worker.addEventListener("message", (event) => {
        if (event.data?.kind === "ready") started.resolve()
      })
      worker.postMessage({
        kind: "init",
        identity: owner,
        dbPath: path.join(root, "export.db"),
        endpoint: "http://127.0.0.1:1",
        allowCustomEndpoint: true,
      })
      await started.promise
      const request = Export.request(owner)
      const reply = await stopExportWorker(worker, request, 15000)
      assert.throws(() => Export.validate({ ...reply, scopes: { version: 1, states: [`${root}-outside`] } }, request))
      assert.throws(() => Export.validate({ ...reply, generation: crypto.randomUUID() }, request))
      assert.equal(Export.validate({ ...reply, scopes: undefined }, request).scopes, undefined)
    }
    if (mode === "index") {
      const request = { runID: env[Index.RUN], generation: env[Index.GENERATION], requestID: crypto.randomUUID() }
      const reply = Promise.withResolvers<Index.Receipt>()
      worker.addEventListener("message", (event) => {
        if (event.data?.type === "result" && event.data.method === "shutdown") {
          if (!event.data.ok) return reply.reject(new Error("Indexing shutdown refused"))
          reply.resolve(Index.validate(event.data.value, request))
        }
      })
      worker.postMessage({ type: "request", id: 1, key: "fixture", method: "shutdown", input: request })
      const value = await reply.promise
      await exited.promise
      assert.throws(() => Index.validate({ ...value, scopes: { version: 1, states: [`${root}-outside`] } }, request))
      assert.throws(() => Index.validate({ ...value, requestID: crypto.randomUUID() }, request))
      assert.equal(Index.validate({ ...value, scopes: undefined }, request).scopes, undefined)
      ProfileParticipants.remember(value)
    }
    await exited.promise
    const value = ProfileParticipants.snapshot().find((item) =>
      item.scopes?.states.some((file) => file.toLowerCase() === state.toLowerCase()),
    )
    assert.ok(value, `${mode} state role was lost`)
    assert.equal(JSON.parse(await Bun.file(path.join(state, "kv.json")).text()).skipped_version, "worker-role-nonce")
    assert.throws(() => workerScopes({ version: 1, states: [`${root}-outside`] }, value.receipt.roots))
  } finally {
    worker.terminate()
  }
}
const records = ProfileParticipants.snapshot()
assert.equal(records.length, 3)
const roles = participantScopes(true).states
const roots = observation().roots
const scopes = await stateScopes({ version: 1, states: roles }, roots, { version: 1, directories: [root], files: [] })
assert.ok(scopes.length >= 3)
assert.throws(() => workerScopes({ version: 1, states: [roles[0], roles[0]] }, roots))
assert.equal(workerScopes(undefined, roots), undefined)
const legacy = {
  ...records[0],
  runID: crypto.randomUUID(),
  generation: crypto.randomUUID(),
  requestID: crypto.randomUUID(),
  scopes: undefined,
}
const registry = participants()
assert.equal(registry.remember(legacy).scopes, undefined)
ProfileParticipants.remember(legacy)
assert.throws(() => participantScopes(true), /lacks confirmed full Global namespace/)
assert.deepEqual(participantScopes(false).states, roles)
await closeProcessProfile()
const helper = await realpath(
  path.resolve(import.meta.dir, "../../../../core/native/kilocode/bin/raya-process-host.exe"),
)
const digest = createHash("sha256")
  .update(await readFile(helper))
  .digest("hex")
let expired: Image | undefined
await withImage(
  {
    roots: scopes,
    policy: { version: 1, directories: [root], files: [] },
    helper: { executable: helper, digest },
    registry: `${root}-registry`,
  },
  async (image) => {
    expired = image
    const value = assertImage(image, scopes)
    for (const mode of ["tui", "export", "index"]) {
      const state = path.join(root, `${mode}-state`)
      const mapped = value.roots.find((item) => item.original.toLowerCase() === state.toLowerCase())
      assert.ok(mapped)
      assert.equal(
        JSON.parse(await Bun.file(path.join(mapped.staged, "kv.json")).text()).skipped_version,
        "worker-role-nonce",
      )
      await assert.rejects(writeFile(path.join(state, "kv.json"), "{}"))
    }
  },
)
assert.throws(() => assertImage(expired, scopes), /expired/)
console.log("WORKER_STATE_ROLES_PASS")
await finish([])
