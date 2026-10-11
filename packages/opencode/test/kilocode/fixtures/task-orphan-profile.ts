import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Git } from "@/git"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { RuntimeFlags } from "@/effect/runtime-flags"

export function profile(dir: string) {
  const db = makeGlobalNode({
    service: Database.Service,
    layer: Database.layerFromPath(path.join(dir, "authority.sqlite")),
    deps: [CrossSpawnSpawner.node, FSUtil.node],
  })
  const store = LayerNode.make({
    service: Storage.Service,
    layer: Storage.layerWithDatabase(path.join(dir, "storage")),
    deps: [FSUtil.node, Git.node, db],
  })
  const root = LayerNode.group([
    FSUtil.node,
    Git.node,
    Database.node,
    Session.node,
    SessionProjector.node,
    Storage.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ])
  // Bootstrapping unrelated workspace plugins is outside this physical recovery fixture.
  return Layer.fresh(
    AppNodeBuilder.build(root, [
      [Database.node, db],
      [Storage.node, store],
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ]).pipe(Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true }))),
  )
}
