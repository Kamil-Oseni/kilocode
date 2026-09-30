import { existsSync, writeFileSync } from "node:fs"
import { Effect, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"

const input = Schema.decodeUnknownSync(
  Schema.Struct({
    dir: Schema.String,
    start: Schema.String,
    ready: Schema.String,
    release: Schema.optional(Schema.String),
    done: Schema.String,
  }),
)(JSON.parse(process.argv[2]))
writeFileSync(input.start, "starting")
await Effect.runPromise(
  Storage.Service.use((store) =>
    store.write(["actual"], {
      toJSON() {
        writeFileSync(input.ready, "admitted")
        if (input.release) {
          const deadline = performance.now() + 8000
          while (!existsSync(input.release)) {
            if (performance.now() > deadline) throw new Error("Actual JSON writer release deadline elapsed")
          }
        }
        return { value: "settled" }
      },
    }),
  ).pipe(
    Effect.provide(Storage.layerFromDir(input.dir)),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  ),
)
await Bun.write(input.done, "settled")
