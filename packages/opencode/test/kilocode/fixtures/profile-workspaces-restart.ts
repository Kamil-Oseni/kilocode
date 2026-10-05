import assert from "node:assert/strict"
import { Effect, ManagedRuntime } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Storage } from "../../../src/storage/storage"
import { hold } from "../../../src/kilocode/task/hold"
import { finish } from "../../../src/kilocode/cli/finish"

const file = process.env.RAYA_DB
assert.ok(file)
const storage = ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([Storage.node])))
const store = await storage.runPromise(Storage.Service)
await assert.rejects(storage.runPromise(hold(store).check()), /paused|transferred profile/)
const runtime = ManagedRuntime.make(Database.layerFromPath(file))
await runtime.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    assert.deepEqual(yield* db.all("SELECT commands FROM project"), [{ commands: null }])
    assert.deepEqual(yield* db.all("SELECT extra FROM workspace"), [{ extra: null }])
    assert.deepEqual(yield* db.all("SELECT id FROM raya_routine_occurrence"), [])
  }),
)
await runtime.dispose()
await storage.dispose()
console.log("WORKSPACE_RESTART_HELD")
await finish([])
