// raya_change - keep goal work on native-tool-calling models while still routing intelligently
import { Effect } from "effect"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

// Goal orchestration and every delegated subagent must be able to call tools natively. The
// Auto/Chief turn that drives a goal is forced onto the configured small model (the session
// prompt ignores the user's picker for the "auto" agent), and each routed specialist runs on
// whatever KiloTask.resolveModel selects. If any of those land on a model that cannot call
// tools (DeepSeek chat, some local models), the workflow silently breaks: chief_route / task /
// get_goal / update_goal never dispatch and the goal stalls or auto-blocks.
//
// This does NOT pin everything to one model. Intelligent routing still happens: the Chief picks
// the specialist, and the user's configured models are honored whenever they can call tools.
// We only step in when the chosen model cannot — and then we pick the *best* available
// tool-capable model rather than an arbitrary first match, ranking by recency then context size.
export namespace RayaToolModel {
  type Ref = { providerID: string; modelID: string }

  type ModelLike = {
    id: ModelV2.ID
    capabilities: { toolcall: boolean }
    limit?: { context?: number }
    release_date?: string
  }

  const capable = (model: { capabilities: { toolcall: boolean } }) => model.capabilities.toolcall !== false

  // Higher is better. Prefer the more recently released model, then the larger context window,
  // with a deterministic id tiebreak so the choice is stable across turns.
  const better = (a: { providerID: string; model: ModelLike }, b: { providerID: string; model: ModelLike }) => {
    const rel = (a.model.release_date ?? "").localeCompare(b.model.release_date ?? "")
    if (rel !== 0) return rel > 0 ? a : b
    const ctx = (a.model.limit?.context ?? 0) - (b.model.limit?.context ?? 0)
    if (ctx !== 0) return ctx > 0 ? a : b
    const id = `${a.providerID}/${a.model.id}`.localeCompare(`${b.providerID}/${b.model.id}`)
    return id <= 0 ? a : b
  }

  // Best tool-capable model available anywhere, preferring the caller's choice, then the user's
  // default, then the top-ranked tool-capable model across every configured provider.
  const best = (provider: Provider.Interface, prefer?: Ref) =>
    Effect.gen(function* () {
      if (prefer) {
        const current = yield* provider
          .getModel(ProviderV2.ID.make(prefer.providerID), ModelV2.ID.make(prefer.modelID))
          .pipe(Effect.option)
        if (current._tag === "Some" && capable(current.value)) return prefer
      }

      const fallback = yield* provider.defaultModel().pipe(Effect.option)
      if (fallback._tag === "Some") {
        const model = yield* provider.getModel(fallback.value.providerID, fallback.value.modelID).pipe(Effect.option)
        if (model._tag === "Some" && capable(model.value))
          return { providerID: fallback.value.providerID, modelID: fallback.value.modelID } satisfies Ref
      }

      const providers = yield* provider.list()
      let top: { providerID: string; model: ModelLike } | undefined
      for (const info of Object.values(providers)) {
        for (const model of Object.values(info.models)) {
          if (!capable(model)) continue
          const item = { providerID: info.id, model }
          top = top ? better(top, item) : item
        }
      }
      if (top) return { providerID: top.providerID, modelID: top.model.id } satisfies Ref
      return prefer
    })

  // Orchestration model for the Auto/Chief turn: the configured candidate when it can call
  // tools, otherwise the best tool-capable substitute (never returns undefined).
  export function orchestration(provider: Provider.Interface, candidate: Ref) {
    return Effect.gen(function* () {
      const resolved = yield* best(provider, candidate)
      return resolved ?? candidate
    })
  }

  // Guard a resolved subagent model: keep it when it can call tools, otherwise upgrade to the
  // best tool-capable model. `changed` lets callers drop a now-meaningless variant.
  export function ensure(provider: Provider.Interface, model: Ref) {
    return Effect.gen(function* () {
      const current = yield* provider
        .getModel(ProviderV2.ID.make(model.providerID), ModelV2.ID.make(model.modelID))
        .pipe(Effect.option)
      if (current._tag === "Some" && !capable(current.value)) {
        const upgraded = yield* best(provider)
        if (upgraded && (upgraded.providerID !== model.providerID || upgraded.modelID !== model.modelID))
          return { model: upgraded, changed: true as const }
      }
      return { model, changed: false as const }
    })
  }
}
