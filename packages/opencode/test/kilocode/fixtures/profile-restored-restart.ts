import assert from "node:assert/strict"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Storage } from "../../../src/storage/storage"
import { hold } from "../../../src/kilocode/task/hold"
import { scheduler } from "../../../src/kilocode/task/scheduler"
import { MemoryPaths } from "@kilocode/kilo-memory/effect/paths"
import { KiloMemory } from "@kilocode/kilo-memory/effect"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { readFile } from "node:fs/promises"
import { Server } from "../../../src/server/server"
import { finish } from "../../../src/kilocode/cli/finish"
import { parse } from "jsonc-parser"

const profile = process.argv[2]
const mode = process.argv[3]
assert.ok(profile)
assert.ok(mode === "held" || mode === "reviewed")
assert.equal(Global.Path.data, profile)
const runtime = ManagedRuntime.make(
  Layer.merge(
    Database.layerFromPath(path.join(profile, "raya.db")),
    AppNodeBuilder.build(LayerNode.group([Storage.node])),
  ),
)
const review = JSON.parse(await readFile(path.join(profile, "restore-review.json"), "utf8"))
const preferences = JSON.parse(await readFile(path.join(profile, "restore-preferences.json"), "utf8"))
assert.equal(preferences.activation, "held")
assert.equal(preferences.reviewOnly, true)
assert.equal(preferences.config.model.modelID, "qwen3:8b")
assert.equal(preferences.modelState.models[0].agent, "auto")
assert.equal(preferences.extensionState.favoriteModels[0].modelID, "qwen3:8b")
assert.equal(JSON.stringify(preferences).includes("SYNTHETIC_PRIVATE_CREDENTIAL"), false)
const config = Bun.file(path.join(process.env.XDG_CONFIG_HOME!, "kilo", "kilo.jsonc"))
if (await config.exists()) {
  const value = parse(await config.text())
  assert.equal(value.model, undefined)
  assert.equal(value.default_agent, undefined)
}
assert.equal(await Bun.file(path.join(process.env.XDG_STATE_HOME!, "kilo", "model.json")).exists(), false)
const workspace = Object.values(review.workspaces)[0]
assert.ok(typeof workspace === "string")
const ctx = { directory: workspace, worktree: workspace }
const memory = MemoryPaths.root({ ctx })
assert.ok(memory.startsWith(path.join(profile, "memory")))
const state = await MemoryFiles.readState(memory)
assert.equal(state.enabled, false)
assert.equal(state.autoConsolidate, false)
assert.equal(state.capture.turnClose, false)
assert.equal(state.capture.explicit, false)
assert.ok((await MemoryFiles.readSource(memory, "project.md")).includes("PERSONAL_MEMORY_MARKER"))
assert.ok((await MemoryFiles.readIndex(memory)).includes("PERSONAL_MEMORY_MARKER"))
assert.ok((await MemoryFiles.readIndex(memory)).includes("SESSION_MEMORY_MARKER"))
const manifest = JSON.parse(await readFile(MemoryPaths.files(memory).manifest, "utf8"))
assert.equal(manifest.canonical, workspace)
assert.equal(manifest.folder, path.basename(memory))
assert.ok((await readFile(path.join(memory, "restore-evidence.json"), "utf8")).includes("HISTORICAL_MEMORY_DECISION"))
assert.deepEqual((await KiloMemory.context({ ctx })).blocks, [])
if (mode === "held") {
  assert.equal((await KiloMemory.enable({ ctx })).state.enabled, false)
  assert.equal((await KiloMemory.configure({ ctx, settings: { autoConsolidate: true } })).state.autoConsolidate, false)
  assert.equal((await MemoryFiles.readState(memory)).enabled, false)
}
if (mode === "reviewed") {
  assert.equal((await KiloMemory.enable({ ctx })).state.enabled, true)
  assert.equal((await MemoryFiles.readState(memory)).capture.turnClose, false)
  assert.equal((await MemoryFiles.readState(memory)).autoConsolidate, false)
  assert.ok(JSON.stringify((await KiloMemory.context({ ctx })).blocks).includes("PERSONAL_MEMORY_MARKER"))
}
await runtime.runPromise(
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const database = yield* Database.Service
    if (mode === "held") {
      yield* hold(storage)
        .check()
        .pipe(
          Effect.match({
            onSuccess: () => {
              throw new Error("Held destination admitted work")
            },
            onFailure: (err) => assert.equal(err.kind, "paused"),
          }),
        )
    } else {
      yield* hold(storage).check()
      assert.equal(yield* scheduler({ database, storage }).prepare("agent", Date.now()), undefined)
    }
    assert.deepEqual(yield* database.db.all("SELECT id FROM raya_routine_occurrence"), [])
    assert.deepEqual(yield* database.db.all("SELECT id FROM session_input"), [])
    const agents = yield* storage.read<{ enabled: boolean; execution?: unknown }[]>(["raya", "agent"])
    assert.equal(agents[0].enabled, false)
    assert.equal(agents[0].execution, undefined)
  }),
)
await runtime.dispose()
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
try {
  const response = await fetch(new URL("/kilocode/agent/agent/runs", listener.url), {
    headers: { "x-kilo-directory": workspace },
  })
  assert.equal(response.status, 200, await response.clone().text())
  const runs = await response.json()
  assert.deepEqual(
    runs.map((run: { status: string }) => run.status),
    ["complete", "error"],
  )
  const events = await fetch(new URL("/kilocode/agent/agent/events", listener.url), {
    headers: { "x-kilo-directory": workspace },
  })
  assert.equal(events.status, 200, await events.clone().text())
  const journal = await events.json()
  assert.equal(journal.cursor, 0)
  assert.deepEqual(journal.events, [])
  const original = JSON.parse(await readFile(path.join(profile, "restore-source.json"), "utf8"))
  const histories = [original, ...(original.archives ?? [])]
    .flatMap((source) => source.json.filter((item: { path: string }) => item.path === "raya/agent-runs/agent.json"))
    .map((item: { value: string }) => JSON.parse(item.value))
    .filter((history) => history.cursor === 3)
  assert.equal(histories.length, 1)
  const history = histories[0]
  assert.equal(history.cursor, 3)
  assert.equal(history.events.length, 3)
  assert.equal(history.runs[2].status, "running")
  console.log("RESTORED_RESTART_RECEIPT " + JSON.stringify({ passed: true, mode, replayed: false, profile }))
} catch (err) {
  process.exitCode = 1
  console.error(err)
} finally {
  await listener.stop(true)
  await finish([])
}
