import assert from "node:assert/strict"
import { Effect, Layer } from "effect"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Git } from "../../../src/git"
import { Storage } from "../../../src/storage/storage"
import { RayaTask } from "../../../src/kilocode/task"
import { SessionID } from "../../../src/session/schema"

// Genuine Source-owned writers publish only a manual roster and historical run records.
const file = process.env.RAYA_DB
assert(file && path.isAbsolute(file))
await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = yield* database.db.all<{ name: string; file: string }>("PRAGMA database_list")
    assert.equal(path.normalize(rows.find((row) => row.name === "main")?.file ?? ""), path.normalize(file))
    const storage = yield* Storage.Service
    const tasks = RayaTask.make({ storage })
    const agent = yield* tasks.create({
      name: "SOURCE_STORAGE café 日本語 😀",
      objective: "Preserve historical records without execution",
      schedule: { kind: "manual" },
    })
    for (const status of ["complete", "blocked"] as const)
      yield* tasks.record({
        id: crypto.randomUUID(),
        agentID: agent.id,
        sessionID: SessionID.make("ses_storage_history_fixture"),
        at: Date.now(),
        status,
      })
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Storage.layerWithDatabase(path.join(Global.Path.data, "storage")).pipe(
        Layer.provideMerge(Layer.fresh(Database.layerFromPath(file))),
      ),
    ),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  ),
)
