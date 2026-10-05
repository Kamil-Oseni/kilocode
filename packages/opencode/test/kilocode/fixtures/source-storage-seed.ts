import { Effect } from "effect"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Git } from "../../../src/git"
import { Storage } from "../../../src/storage/storage"
import { RayaTask } from "../../../src/kilocode/task"
import { SessionID } from "../../../src/session/schema"

// Genuine Source-owned writers publish only a manual roster and historical run records.
await Effect.runPromise(
  Effect.gen(function* () {
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
    Effect.provide(Storage.layerFromDir(path.join(Global.Path.data, "storage"))),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  ),
)
