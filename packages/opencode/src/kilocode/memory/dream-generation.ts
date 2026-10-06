import { Effect } from "effect"
import { MemoryContract } from "@kilocode/kilo-memory/effect/httpapi"
import { MemoryConfig } from "@kilocode/kilo-memory/effect/config"
import { MemoryError, MemoryInvalidInputError } from "@kilocode/kilo-memory/effect/errors"
import { EffectBridge } from "@/effect/bridge"
import type { Provider } from "@/provider/provider"
import { MemoryModel } from "./ports"

/** Prepared-text transport only. Native input grants, notes and proposal publication stay outside it. */
export const generate = Effect.fn("MemoryDream.generate")(function* (
  provider: Provider.Interface,
  input: typeof MemoryContract.DreamGeneratePayload.Type,
) {
  const payload = structuredClone(input)
  const selected = MemoryConfig.parse(payload.model)
  if (!selected) return yield* Effect.fail(new MemoryInvalidInputError({ reason: "Select an explicit Dream model" }))
  const model = MemoryModel.port({ provider })
  const resolved = yield* model.resolve({ configured: payload.model, session: selected })
  if (resolved.fallback)
    return yield* Effect.fail(new MemoryInvalidInputError({ reason: "Dream model selection changed; review it again" }))
  const bridge = yield* EffectBridge.make()
  const result = yield* Effect.callback<{ text: string; usage: unknown }, MemoryError>((resume) => {
    const controller = new AbortController()
    const work = Promise.resolve().then(
      bridge.bind(() =>
        model.run({
          handle: resolved.handle,
          system: payload.system,
          prompt: payload.prompt,
          timeoutMs: payload.timeoutMs,
          budget: { ...payload.budget },
          signal: controller.signal,
        }),
      ),
    )
    void work.then(
      (value) => resume(Effect.succeed(value)),
      (error: unknown) => resume(Effect.fail(MemoryError.from(error))),
    )
    // Interrupting the request does not abandon the original SDK operation or start a replacement.
    return Effect.promise(async () => {
      controller.abort(new DOMException("Original Dream transport cancelled", "AbortError"))
      await Promise.allSettled([work])
    })
  })
  return {
    id: payload.id,
    owner: payload.owner,
    configuredModel: payload.model,
    text: result.text,
    settlement: "sdk" as const,
  }
})
