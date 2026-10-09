// kilocode_change - new file
import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Storage } from "@/storage/storage"
import { read as bounded } from "@/kilocode/storage/bounded-read"
import { tmpdirScoped } from "./fixture"

const layer = LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node]))

/** Adapt legacy Map fixtures through the actual bounded reader, without a second cap implementation. */
export function read<T>(data: Map<string, unknown>, key: string[], maximum: number) {
  return Effect.gen(function* () {
    const value = data.get(key.join("/"))
    if (value === undefined) return yield* new Storage.NotFoundError({ message: "missing" })
    const fs = yield* FSUtil.Service
    const directory = yield* tmpdirScoped()
    const target = path.join(directory, "selected.json")
    yield* fs.writeFileString(target, JSON.stringify(value, null, 2))
    return (yield* bounded(fs, target, maximum)) as T
  }).pipe(Effect.scoped, Effect.provide(layer))
}
