import assert from "node:assert/strict"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Git } from "../../../src/git"
import { Storage } from "../../../src/storage/storage"
import { make } from "../../../src/kilocode/voice/openai"

// Invoke the actual writer; no voice binding/provider/usage receipt is invented.
const file = process.env.RAYA_DB
assert(file && path.isAbsolute(file))
await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const database = yield* Database.Service
    const voice = yield* make({
      storage,
      database,
      sessions: { get: () => Effect.die("Voice seed unexpectedly requested a session") },
      prompts: { prompt: () => Effect.die("Voice seed unexpectedly requested inference") },
      workers: { cancel: () => Effect.die("Voice seed unexpectedly cancelled work") },
    })
    const value = yield* voice.reconcile(1)
    assert.equal(value.status, "complete")
    assert.equal(value.cycle, 1)
    assert.equal(value.receipts, 0)
    assert.equal(value.scanned, 0)
    console.log(
      "RAYA_VOICE_SEED " +
        JSON.stringify({ cycle: value.cycle, status: value.status, scanned: value.scanned, receipts: value.receipts }),
    )
  }).pipe(
    Effect.scoped,
    Effect.provide(Database.layerFromPath(file)),
    Effect.provide(Storage.layerFromDir(path.join(Global.Path.data, "storage"))),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  ),
)
