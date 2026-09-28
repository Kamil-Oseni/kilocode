import fs from "node:fs/promises"
import { Cause, Effect, Exit, Schema } from "effect"
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
      mode: Schema.Literals(["writer", "review", "reserve", "retire", "forget", "control"]),
    }),
  ),
)(process.argv[2])
const layer = AppNodeBuilder.build(LayerNode.group([WorkspaceOccupancy.node, Project.node]), [
  [Global.node, Global.layerWith({ state: input.state })],
])
await Effect.runPromise(
  Effect.gen(function* () {
    const occupancy = yield* WorkspaceOccupancy.Service
    if (input.mode === "control") {
      yield* Effect.promise(() => fs.writeFile(input.ready, JSON.stringify({ id: "ready" })))
      const deadline = performance.now() + 60000
      while (performance.now() < deadline) {
        const source = yield* Effect.promise(() =>
          fs.readFile(input.release, "utf8").catch((err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") return undefined
            throw err
          }),
        )
        if (!source) {
          yield* Effect.sleep(20)
          continue
        }
        const command = Schema.decodeUnknownSync(
          Schema.Struct({
            id: Schema.String,
            operation: Schema.Literals(["review", "retire", "forget", "done"]),
            identity: Schema.optional(WorkspaceOccupancy.Reservation),
          }),
        )(JSON.parse(source))
        yield* Effect.promise(() => fs.unlink(input.release))
        if (command.operation === "done") return
        const action =
          command.operation === "review"
            ? occupancy.review([input.workspace])(Effect.void)
            : command.identity
              ? command.operation === "retire"
                ? occupancy.retire(command.identity)
                : occupancy.forget(command.identity)
              : Effect.die(new Error("Missing fixture identity"))
        const result = yield* action.pipe(Effect.exit)
        yield* Effect.promise(() =>
          fs.writeFile(
            input.ready + ".tmp",
            JSON.stringify({
              id: command.id,
              ok: Exit.isSuccess(result),
              message: Exit.isFailure(result) ? Cause.pretty(result.cause) : "",
            }),
          ),
        )
        yield* Effect.promise(() => fs.rename(input.ready + ".tmp", input.ready))
      }
      throw new Error("Controller fixture exceeded its deadline")
    }
    if (input.mode === "review") {
      const exit = yield* occupancy.review([input.workspace])(Effect.void).pipe(Effect.exit)
      yield* Effect.promise(() => fs.writeFile(input.ready, exit._tag))
      return
    }
    if (input.mode === "retire" || input.mode === "forget") {
      const identity = Schema.decodeUnknownSync(WorkspaceOccupancy.Reservation)(
        JSON.parse(yield* Effect.promise(() => fs.readFile(input.release, "utf8"))),
      )
      yield* input.mode === "retire" ? occupancy.retire(identity) : occupancy.forget(identity)
      yield* Effect.promise(() => fs.writeFile(input.ready, "confirmed"))
      return
    }
    const project = yield* Project.Service
    const found = yield* project.fromDirectory(input.workspace)
    const ctx = { directory: input.workspace, worktree: found.sandbox, project: found.project }
    if (input.mode === "reserve") {
      const actor = yield* occupancy.reserve(ctx, "process-worker")
      yield* Effect.promise(() => fs.writeFile(input.ready, JSON.stringify(actor.identity)))
      return
    }
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
