import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { SessionID } from "@/session/schema"

const dir = process.argv[2]
const agent = process.argv[3]
const run = process.argv[4]
const session = process.argv[5]
const mode = process.argv[6] ?? "idle"
if (!dir || !agent || !run || !session || (mode !== "idle" && mode !== "active"))
  throw new Error("Expected storage, exact execution identity, and mode")

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const execution = RayaTaskExecution.make(yield* Storage.Service)
    const owner = { id: run, agentID: agent, sessionID: SessionID.make(session) }
    if (!(yield* execution.acquire(owner))) return false
    if (mode === "active") return true
    return (yield* execution.enter(owner, Effect.succeed(true))) === true
  }).pipe(
    Effect.provide(Storage.layerFromDir(dir)),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
    Effect.exit,
  ),
)

process.exit(Exit.isSuccess(result) && result.value ? 0 : 10)
