import path from "node:path"
import { Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import { tmpdirScoped } from "../../fixture/fixture"

/** Actual scoped physical selected database; never override the production admission rules. */
export const database = makeGlobalNode({
  service: Database.Service,
  layer: Layer.unwrap(
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      return Database.layerFromPath(path.join(root, "authority.sqlite"))
    }),
  ).pipe(Layer.orDie),
  deps: [CrossSpawnSpawner.node, FSUtil.node],
})

/** Derive the actual file store from that same selected physical database. */
export const storage = LayerNode.make({
  service: Storage.Service,
  layer: Layer.unwrap(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const rows = yield* database.db.all<{ name: string; file: string }>("PRAGMA database_list")
      const main = rows.find((row) => row.name === "main")
      if (!main?.file || !path.isAbsolute(main.file)) throw new Error("Owned physical selected database missing")
      return Storage.layerWithDatabase(path.join(path.dirname(main.file), "storage")).pipe(
        Layer.provide(Layer.succeed(Database.Service, database)),
      )
    }),
  ).pipe(Layer.orDie),
  deps: [FSUtil.node, Git.node, Database.node],
})
