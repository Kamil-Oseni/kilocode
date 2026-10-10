import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { selected } from "@/kilocode/migration/storage-scope"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))

it.live("actual nondefault storage selection is bound only while the original service layer is live", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "explicit-selected-storage")
    const service = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Storage.Service
        expect(selected(service)).toBe(dir)
        expect(() => selected({})).toThrow("unavailable or retired")
        return service
      }).pipe(Effect.provide(Storage.layerFromDir(dir))),
    )
    expect(() => selected(service)).toThrow("unavailable or retired")
    // Merely reviewing the live metadata must not run storage migration or create a root.
    const fs = yield* FSUtil.Service
    expect(yield* fs.exists(dir)).toBe(false)
  }),
)
