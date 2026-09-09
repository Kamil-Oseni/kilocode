import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Provider.node))

it.instance(
  "explicit auxiliary model configuration can select another provider",
  Effect.gen(function* () {
    const model = yield* Provider.Service.use((provider) => provider.getSmallModel(ProviderV2.ID.make("source")))
    expect(model).toMatchObject({ providerID: "configured", id: "fast" })
  }),
  {
    config: {
      enabled_providers: ["source", "configured"],
      small_model: "configured/fast",
      provider: {
        source: { npm: "@ai-sdk/openai-compatible", models: { main: {} }, options: { apiKey: "fixture" } },
        configured: { npm: "@ai-sdk/openai-compatible", models: { fast: {} }, options: { apiKey: "fixture" } },
      },
    },
  },
)

it.instance(
  "Kilo selection retains its own small model without a cross-provider fallback",
  Effect.gen(function* () {
    const model = yield* Provider.Service.use((provider) => provider.getSmallModel(ProviderV2.ID.make("kilo")))
    expect(model).toMatchObject({ providerID: "kilo", id: "kilo-auto/small" })
  }),
  { config: { enabled_providers: ["kilo"] } },
)
