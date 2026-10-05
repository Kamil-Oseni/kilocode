import assert from "node:assert/strict"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import { ManagedRuntime } from "effect"
import { KiloShutdown } from "../../../src/kilocode/cli/shutdown"

const root = process.env.RAYA_TEST_SECONDARY_ROOT
assert(root && path.isAbsolute(root))
for (const name of ["graph-one", "graph-two"]) {
  const data = path.join(root, name, "kilo")
  for (const role of ["home", "state", "config", "cache", "bin", "log", "repos"])
    await mkdir(path.join(data, role), { recursive: true })
  Global.make({
    data,
    home: path.join(data, "home"),
    state: path.join(data, "state"),
    config: path.join(data, "config"),
    cache: path.join(data, "cache"),
    bin: path.join(data, "bin"),
    log: path.join(data, "log"),
    repos: path.join(data, "repos"),
  })
  const runtime = ManagedRuntime.make(Database.layerFromPath(path.join(data, "raya.db")))
  KiloShutdown.register(() => runtime.dispose())
  await runtime.runPromise(Database.Service)
}
await import("../../../src/index")
