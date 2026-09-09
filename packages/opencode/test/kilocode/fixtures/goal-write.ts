import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Storage } from "../../../src/storage/storage"
import { Git } from "../../../src/git"
import { SessionID } from "../../../src/session/schema"
import { RayaGoal } from "../../../src/kilocode/goal"
import { mutation } from "../../../src/kilocode/goal/mutation"

const [directory, id, action] = process.argv.slice(2)
if (!directory || !id || !action) throw new Error("Expected storage directory, session and action")
await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    if (action === "crash")
      yield* mutation(
        storage,
        id,
        Effect.sync(() => process.exit(21)),
      )
    const goals = RayaGoal.make({
      storage,
      sessions: { messages: () => Effect.succeed([]), children: () => Effect.succeed([]) },
    })
    yield* goals.revise(SessionID.make(id), action)
  }).pipe(
    Effect.provide(Storage.layerFromDir(directory)),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, Git.node]))),
  ),
)
