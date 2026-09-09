import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "../../../src/git"
import { Storage } from "../../../src/storage/storage"
import { RayaTask } from "../../../src/kilocode/task"
import { mutate } from "../../../src/kilocode/task/mutation"
import { SessionID } from "../../../src/session/schema"

const directory = process.argv[2]
const owner = process.argv[3]
const target = process.argv[4]
if (!directory || !owner || !target) throw new Error("Expected storage directory, owner, and routine ID")
await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    if (owner === "crash")
        yield* mutate(
        storage,
        Effect.sync(() => process.exit(21)),
      )
    const tasks = RayaTask.make({ storage })
    for (let index = 0; index < 3; index++) {
      yield* tasks.create({ name: `${owner}-${index}`, objective: "Work", schedule: { kind: "manual" } })
      yield* tasks.record({
        id: `${owner}-${index}`,
        agentID: target,
        sessionID: SessionID.make(`ses_${owner}_${index}`),
        at: index,
        status: "complete",
      })
    }
  }).pipe(
    Effect.provide(Storage.layerFromDir(directory)),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  ),
)
