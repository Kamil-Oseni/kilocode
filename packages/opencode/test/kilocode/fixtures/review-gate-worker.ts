import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import { ReviewGate } from "@/kilocode/session/review-gate"

const Input = Schema.fromJsonString(
  Schema.Struct({
    workspace: Schema.String,
    state: Schema.String,
    active: Schema.String,
    ready: Schema.String,
    done: Schema.String,
    hold: Schema.Number,
  }),
)
const input = Schema.decodeUnknownSync(Input)(process.argv[2])

const global = Global.layerWith({
  home: input.state,
  data: input.state,
  cache: input.state,
  config: input.state,
  state: input.state,
  bin: input.state,
  log: input.state,
})
const layer = AppNodeBuilder.build(ReviewGate.node, [[Global.node, global]])

await Effect.runPromise(
  ReviewGate.Service.use((gate) =>
    gate.withWorkspace(input.workspace)(
      Effect.gen(function* () {
        const occupied = yield* Effect.promise(() => fs.stat(input.active).then(() => true, () => false))
        if (occupied) return yield* Effect.die(new Error("review transaction overlapped"))
        yield* Effect.promise(() => fs.writeFile(input.active, String(process.pid)))
        yield* Effect.promise(() => fs.writeFile(input.ready, "ready"))
        yield* Effect.sleep(input.hold)
        yield* Effect.promise(() => fs.rm(input.active))
        return yield* Effect.promise(() => fs.writeFile(input.done, "done"))
      }),
    ),
  ).pipe(Effect.provide(layer)),
)
