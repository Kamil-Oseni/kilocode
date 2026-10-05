import assert from "node:assert/strict"
import path from "node:path"
import { Effect, Layer, Logger, ManagedRuntime } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode-ai/core/global"
import { Log } from "@opencode-ai/core/util/log"
import { ownedFileLogger } from "@opencode-ai/core/kilocode/file-logger"
import { Identity } from "../../../../kilo-telemetry/src/identity"

// Real writers publish before Source startup; its actual finish owns final logger retirement.
Identity.setDataPath(Global.Path.data)
assert(await Identity.getMachineId())
await Log.init({ print: false, dev: true })
Log.Default.info("PRIVATE_OPERATIONAL_DIAGNOSTIC_DO_NOT_TRANSFER")
const runtime = ManagedRuntime.make(
  Logger.layer([
    ownedFileLogger(
      Logger.make((opts) => String(opts.message)),
      path.join(Global.Path.log, "opencode.log"),
    ),
  ]).pipe(Layer.provide(NodeFileSystem.layer)),
)
await runtime.runPromise(Effect.logInfo("PRIVATE_OPERATIONAL_DIAGNOSTIC_DO_NOT_TRANSFER"))
await runtime.dispose()
