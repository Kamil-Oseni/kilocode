import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Auth } from "../../../src/auth"

Global.Path.data = process.argv[3]!
await Effect.runPromise(
  Effect.gen(function* () {
    yield* (yield* Auth.Service).set("external", { type: "api", key: "synthetic-external" })
  }).pipe(Effect.provide(Auth.defaultLayer)),
)
