import assert from "node:assert/strict"
import path from "node:path"
import { Effect, Layer, Logger, ManagedRuntime } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Log } from "@opencode-ai/core/util/log"
import { ownedFileLogger, drainFileLoggers } from "@opencode-ai/core/kilocode/file-logger"
import { Identity } from "../../../../kilo-telemetry/src/identity"
import { Storage } from "../../../src/storage/storage"
import { Git } from "../../../src/git"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.argv[2]
assert(root && path.isAbsolute(root))
Global.Path.log = path.join(root, "log")
Identity.setDataPath(path.join(root, "data"))
assert(await Identity.getMachineId())
await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    yield* storage.list([])
  }).pipe(
    Effect.scoped,
    Effect.provide(Storage.layerFromDir(path.join(root, "data", "storage"))),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  ),
)
await Log.init({ print: false, dev: true })
Log.Default.info("PRIVATE_DIAGNOSTIC_CONTENT_MUST_NOT_TRANSFER")
await Log.drain()
const runtime = ManagedRuntime.make(
  Logger.layer([
    ownedFileLogger(
      Logger.make((opts) => String(opts.message)),
      path.join(Global.Path.log, "opencode.log"),
    ),
  ]).pipe(Layer.provide(NodeFileSystem.layer)),
)
await runtime.runPromise(Effect.logInfo("PRIVATE_DIAGNOSTIC_CONTENT_MUST_NOT_TRANSFER"))
await runtime.dispose()
await drainFileLoggers()
await finish([])
