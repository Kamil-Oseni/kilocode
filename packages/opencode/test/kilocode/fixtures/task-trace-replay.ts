import path from "node:path"
import { Effect, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "../../../src/git"
import { Storage } from "../../../src/storage/storage"
import { RayaTask } from "../../../src/kilocode/task"

const [dir, id, cursor] = process.argv.slice(2)
if (!dir || !path.isAbsolute(dir) || !id || !Number.isSafeInteger(Number(cursor)))
  throw new Error("Expected a disposable storage directory, worker and replay cursor")
const layer = LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))
await Effect.runPromise(
  Effect.gen(function* () {
    const tasks = RayaTask.make({ storage: yield* Storage.Service })
    const result = yield* Effect.exit(tasks.eventsFor(id, Number(cursor)))
    console.log(
      "RAYA_TRACE_RESULT " + JSON.stringify(Exit.isSuccess(result) ? { page: result.value } : { refused: true }),
    )
  }).pipe(Effect.provide(Storage.layerFromDir(dir)), Effect.provide(layer), Effect.scoped),
)
