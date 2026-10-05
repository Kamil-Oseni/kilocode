import { run as runTui, type TuiInput } from "@opencode-ai/tui"
import { Global } from "@opencode-ai/core/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect } from "effect"
import { scope } from "@/kilocode/cli/cmd/tui/model-state" // kilocode_change

export function run(input: TuiInput) {
  // kilocode_change start - join parent-side publication before renderer scope returns to worker shutdown.
  return Effect.gen(function* () {
    const global = yield* Global.Service
    return yield* scope(global.state, (model) => runTui({ ...input, model }))
  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
  // kilocode_change end
}
