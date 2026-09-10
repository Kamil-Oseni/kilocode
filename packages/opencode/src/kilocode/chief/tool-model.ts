import { Effect, Schema } from "effect"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

export namespace RayaToolModel {
  type Ref = { providerID: string; modelID: string }

  export class SelectionError extends Schema.TaggedErrorClass<SelectionError>()("RayaModelSelectionError", {
    providerID: Schema.String,
    modelID: Schema.String,
    reason: Schema.Literals(["missing", "unsupported", "unknown", "variant"]),
    variant: Schema.optional(Schema.String),
  }) {
    override get message() {
      const model = `${this.providerID}/${this.modelID}`
      if (this.reason === "missing")
        return `Selected model ${model} is unavailable. Choose an available tool-capable model; Raya did not substitute another model or provider.`
      if (this.reason === "variant")
        return `Selected variant ${this.variant} is unavailable for ${model}. Choose an available variant; Raya did not downgrade the selection.`
      return `Selected model ${model} ${this.reason === "unsupported" ? "does not support" : "has no recognized capability flag for"} native tool calls. Choose a tool-capable model; Raya did not substitute another model or provider.`
    }
  }

  // These are normalized provider flags. Provider ingestion may default missing catalog
  // metadata to true; this guard does not establish original metadata provenance or probe a model.
  export const ensure = Effect.fn("RayaToolModel.ensure")(function* (provider: Provider.Interface, ref: Ref) {
    const model = yield* provider
      .getModel(ProviderV2.ID.make(ref.providerID), ModelV2.ID.make(ref.modelID))
      .pipe(Effect.mapError(() => new SelectionError({ ...ref, reason: "missing" })))
    if (model.capabilities.toolcall !== true)
      return yield* new SelectionError({
        ...ref,
        reason: model.capabilities.toolcall === false ? "unsupported" : "unknown",
      })
    return model
  })

  export function variant(model: Provider.Model, value?: string) {
    if (!value || value === "default" || Object.hasOwn(model.variants ?? {}, value)) return Effect.succeed(value)
    return Effect.fail(
      new SelectionError({ providerID: model.providerID, modelID: model.id, reason: "variant", variant: value }),
    )
  }

  export const resume = Effect.fn("RayaToolModel.resume")(function* (
    provider: Provider.Interface,
    ref: Ref & { variant?: string },
  ) {
    const model = yield* ensure(provider, ref)
    yield* variant(model, ref.variant)
    return model
  })

  // Only application-selected defaults may use this compatibility fallback. Never cross
  // the candidate's provider boundary. Recency/context are deterministic ties, not quality scores.
  export const orchestration = Effect.fn("RayaToolModel.orchestration")(function* (
    provider: Provider.Interface,
    candidate: Ref,
  ) {
    const result = yield* ensure(provider, candidate).pipe(Effect.result)
    if (result._tag === "Success") return result.success
    const providers = yield* provider.list()
    const models = Object.values(providers[ProviderV2.ID.make(candidate.providerID)]?.models ?? {})
      .filter((model) => model.providerID === candidate.providerID && model.capabilities.toolcall === true)
      .toSorted(
        (a, b) =>
          (b.release_date ?? "").localeCompare(a.release_date ?? "") ||
          (b.limit.context ?? 0) - (a.limit.context ?? 0) ||
          a.id.localeCompare(b.id),
      )
    const model = models[0]
    if (!model) return yield* result.failure
    return yield* ensure(provider, { providerID: model.providerID, modelID: model.id })
  })

  export const dispatch = Effect.fn("RayaToolModel.dispatch")(function* (
    provider: Provider.Interface,
    configured: (Ref & { variant?: string }) | undefined,
    requested: Ref & { variant?: string },
    selected?: string,
  ) {
    const model = yield* configured
      ? ensure(provider, configured)
      : requested.providerID !== ProviderV2.ID.kilo
        ? ensure(provider, requested)
        : orchestration(provider, { providerID: ProviderV2.ID.kilo, modelID: "kilo-auto/small" })
    const same = model.providerID === requested.providerID && model.id === requested.modelID
    const value = yield* variant(
      model,
      same ? (selected ?? configured?.variant ?? requested.variant) : configured?.variant,
    )
    return { model: { providerID: model.providerID, modelID: model.id }, variant: value }
  })
}
