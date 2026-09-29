import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { SessionID } from "@/session/schema"

const dir = process.argv[2]
const ready = process.argv[3]
const mode = process.argv[4]
if (!dir || !ready || (mode !== "hold" && mode !== "once")) throw new Error("Expected storage, receipt, and mode")

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const execution = RayaTaskExecution.make(storage)
    const permit = yield* execution.acquire({
      id: "run_execution",
      agentID: "agent_execution",
      sessionID: SessionID.make("ses_execution"),
    })
    if (!permit) return "joined"
    yield* execution.enter(
      { id: "run_execution", agentID: "agent_execution", sessionID: SessionID.make("ses_execution") },
      Effect.promise(async () => {
        await Bun.write(ready, mode === "hold" ? "owned" : "taken-over")
        if (mode === "hold") for (;;) await Bun.sleep(1_000)
      }),
    )
    return "complete"
  }).pipe(
    Effect.provide(Storage.layerFromDir(dir)),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
    Effect.exit,
  ),
)
if (Exit.isFailure(result)) {
  await Bun.write(ready, "denied")
  process.exit(10)
}
if (result.value === "joined") {
  await Bun.write(ready, "joined")
  process.exit(11)
}
