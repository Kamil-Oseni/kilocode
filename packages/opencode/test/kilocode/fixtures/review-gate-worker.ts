import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import { ReviewGate } from "@/kilocode/session/review-gate"

const Input = Schema.fromJsonString(
  Schema.Struct({
    workspace: Schema.String,
    workspaces: Schema.optional(Schema.Array(Schema.String)),
    sibling: Schema.optional(Schema.String),
    started: Schema.optional(Schema.String),
    go: Schema.optional(Schema.String),
    release: Schema.optional(Schema.String),
    failure: Schema.optional(Schema.Literals(["failure", "interruption"])),
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

const wait = (file: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 30_000
    while (Date.now() < stop) {
      if (
        yield* Effect.promise(() =>
          fs.stat(file).then(
            () => true,
            () => false,
          ),
        )
      )
        return
      yield* Effect.sleep(20)
    }
    yield* Effect.die(new Error(`Timed out waiting for ${file}`))
  })

await Effect.runPromise(
  ReviewGate.Service.use((gate) =>
    Effect.gen(function* () {
      if (input.started) yield* Effect.promise(() => fs.writeFile(input.started!, "started"))
      if (input.go) yield* wait(input.go)
      const body = Effect.gen(function* () {
        // Exclusive creation detects overlap even when two processes enter at the same instant.
        yield* Effect.promise(() => fs.writeFile(input.active, String(process.pid), { flag: "wx" }))
        yield* Effect.promise(() => fs.writeFile(input.ready, "ready"))
        if (input.release) yield* wait(input.release)
        yield* Effect.sleep(input.hold)
        yield* Effect.promise(() => fs.rm(input.active))
        return yield* Effect.promise(() => fs.writeFile(input.done, "done"))
      })
      const first = input.workspaces
        ? gate.withWorkspaces(input.workspaces)(body)
        : gate.withWorkspace(input.workspace)(body)
      if (input.failure) {
        const result = yield* gate
          .withWorkspaces(input.workspaces ?? [input.workspace])(
            input.failure === "failure" ? Effect.fail("expected failure") : Effect.interrupt,
          )
          .pipe(Effect.exit)
        if (!Exit.isFailure(result)) return yield* Effect.die(new Error("Expected unsuccessful body"))
      }
      if (input.sibling)
        return yield* Effect.all([first, gate.withWorkspaces([input.sibling])(body)], { concurrency: 2 })
      return yield* first
    }),
  ).pipe(Effect.provide(layer)),
)
