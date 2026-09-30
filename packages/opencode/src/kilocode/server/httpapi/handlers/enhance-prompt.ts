import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { EffectBridge } from "@/effect/bridge"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { enhancePrompt } from "@/kilocode/enhance-prompt"
import { EnhancePromptPayload } from "../groups/enhance-prompt"

export const enhancePromptHandlers = HttpApiBuilder.group(InstanceHttpApi, "enhance-prompt", (handlers) =>
  Effect.gen(function* () {
    const enhance = Effect.fn("EnhancePromptHttpApi.enhance")(function* (ctx: {
      payload: typeof EnhancePromptPayload.Type
    }) {
      const run = EffectBridge.bind((signal: AbortSignal) => enhancePrompt(ctx.payload.text, ctx.payload.model, signal))
      // Effect enables cancellation from callback arity; the bound rest-argument callback has length zero.
      const text = yield* Effect.promise((signal) => run(signal))
      return { text }
    })

    return handlers.handle("enhance", enhance)
  }),
)
