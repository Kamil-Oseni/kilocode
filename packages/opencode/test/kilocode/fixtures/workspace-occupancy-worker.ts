import fs from "node:fs/promises"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { WorkspaceOccupancy } from "@/kilocode/session/workspace-occupancy"
import * as Project from "@/project/project"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const input = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      state: Schema.String,
      workspace: Schema.String,
      ready: Schema.String,
      release: Schema.String,
      mode: Schema.Literals(["writer", "review"]),
    }),
  ),
)(process.argv[2])
const layer = AppNodeBuilder.build(LayerNode.group([WorkspaceOccupancy.node, Project.node]), [
  [Global.node, Global.layerWith({ state: input.state })],
])
await Effect.runPromise(
  Effect.gen(function* () {
    const occupancy = yield* WorkspaceOccupancy.Service
    if (input.mode === "review") {
      const exit = yield* occupancy.review([input.workspace])(Effect.void).pipe(Effect.exit)
      yield* Effect.promise(() => fs.writeFile(input.ready, exit._tag))
      return
    }
    const project = yield* Project.Service
    const found = yield* project.fromDirectory(input.workspace)
    const release = yield* occupancy.register(
      { directory: input.workspace, worktree: found.sandbox, project: found.project },
      "process-worker",
    )
    yield* Effect.promise(() => fs.writeFile(input.ready, "running"))
    const stop = Date.now() + 60_000
    while (Date.now() < stop) {
      const exists = yield* Effect.promise(() =>
        fs.stat(input.release).then(
          () => true,
          () => false,
        ),
      )
      if (exists) {
        yield* release
        return
      }
      yield* Effect.sleep(20)
    }
    yield* Effect.die(new Error("Timed out waiting for release"))
  }).pipe(Effect.provide(layer)),
)
