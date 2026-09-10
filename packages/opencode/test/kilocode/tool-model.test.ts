import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../../src/agent/agent"
import { Provider } from "../../src/provider/provider"
import { RayaToolModel } from "../../src/kilocode/chief/tool-model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Agent.node, CrossSpawnSpawner.node])))
afterEach(disposeAllInstances)

const entry = (tool_call?: boolean, release_date = "2025-01-01") => ({
  name: "Fixture model",
  ...(tool_call === undefined ? {} : { tool_call }),
  release_date,
  limit: { context: 100000, output: 10000 },
  variants: { careful: {} },
})
const config = {
  enabled_providers: ["local", "other", "kilo"],
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "fixture", baseURL: "http://127.0.0.1:1/v1" },
      models: { good: entry(true), bad: entry(false), unspecified: entry() },
    },
    other: {
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "fixture", baseURL: "http://127.0.0.1:1/v1" },
      models: { newer: entry(true, "2026-01-01") },
    },
    kilo: {
      npm: "@ai-sdk/openai-compatible",
      whitelist: ["kilo-auto/small", "compatible"],
      options: { apiKey: "fixture", baseURL: "http://127.0.0.1:1/v1" },
      models: { "kilo-auto/small": entry(false), compatible: entry(true) },
    },
  },
}

function run<A, E>(fn: (provider: Provider.Interface) => Effect.Effect<A, E>, cfg = config) {
  return provideTmpdirInstance(() => Provider.Service.use(fn), { config: cfg })
}

it.live("exact compatible model is retained even with a newer alternative", () =>
  run((provider) =>
    RayaToolModel.ensure(provider, { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("good") }),
  ).pipe(
    Effect.map((model) =>
      expect({ providerID: model.providerID, modelID: model.id }).toEqual({
        providerID: ProviderV2.ID.make("local"),
        modelID: ModelV2.ID.make("good"),
      }),
    ),
  ),
)

for (const [modelID, reason] of [
  ["bad", "unsupported"],
  ["missing", "missing"],
] as const) {
  it.live(`exact ${modelID} model refuses instead of selecting another model or provider`, () =>
    run((provider) => RayaToolModel.ensure(provider, { providerID: ProviderV2.ID.make("local"), modelID })).pipe(
      Effect.result,
      Effect.map((result) => {
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(RayaToolModel.SelectionError)
          expect(result.failure).toMatchObject({ providerID: ProviderV2.ID.make("local"), modelID, reason })
        }
      }),
    ),
  )
}

it.live("implicit Kilo default falls back only within Kilo", () =>
  run((provider) =>
    RayaToolModel.dispatch(provider, undefined, {
      providerID: ProviderV2.ID.make("kilo"),
      modelID: ModelV2.ID.make("compatible"),
    }),
  ).pipe(
    Effect.map((result) =>
      expect(result).toEqual({
        model: { providerID: ProviderV2.ID.make("kilo"), modelID: ModelV2.ID.make("compatible") },
        variant: undefined,
      }),
    ),
  ),
)

it.live("automatic fallback refuses when only another provider has a compatible model", () =>
  run((provider) =>
    RayaToolModel.orchestration(provider, {
      providerID: ProviderV2.ID.make("absent"),
      modelID: ModelV2.ID.make("small"),
    }),
  ).pipe(
    Effect.result,
    Effect.map((result) => {
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          providerID: ProviderV2.ID.make("absent"),
          modelID: ModelV2.ID.make("small"),
          reason: "missing",
        })
    }),
  ),
)

it.live("implicit non-Kilo Auto uses the exact requested model and variant", () =>
  run((provider) =>
    RayaToolModel.dispatch(
      provider,
      undefined,
      { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("good") },
      "careful",
    ),
  ).pipe(
    Effect.map((result) =>
      expect(result).toEqual({
        model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("good") },
        variant: "careful",
      }),
    ),
  ),
)

it.live("explicit Auto choice does not use automatic same-provider fallback", () =>
  run((provider) =>
    RayaToolModel.dispatch(
      provider,
      { providerID: ProviderV2.ID.make("kilo"), modelID: ModelV2.ID.make("kilo-auto/small") },
      { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("good") },
    ),
  ).pipe(
    Effect.result,
    Effect.map((result) => {
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.reason).toBe("unsupported")
    }),
  ),
)

it.live("explicit configured Auto provider is honored without borrowing the parent variant", () =>
  run((provider) =>
    RayaToolModel.dispatch(
      provider,
      { providerID: ProviderV2.ID.make("other"), modelID: ModelV2.ID.make("newer"), variant: "careful" },
      { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("good") },
      "parent-only",
    ),
  ).pipe(
    Effect.map((result) =>
      expect(result).toEqual({
        model: { providerID: ProviderV2.ID.make("other"), modelID: ModelV2.ID.make("newer") },
        variant: "careful",
      }),
    ),
  ),
)

it.live("invalid explicit variant refuses instead of silently downgrading", () =>
  run((provider) =>
    RayaToolModel.dispatch(
      provider,
      undefined,
      { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("good") },
      "missing",
    ),
  ).pipe(
    Effect.result,
    Effect.map((result) => {
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toMatchObject({ reason: "variant", variant: "missing" })
    }),
  ),
)

it.live("default variant retains its existing no-override meaning", () =>
  run((provider) =>
    RayaToolModel.dispatch(
      provider,
      undefined,
      { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("good") },
      "default",
    ),
  ).pipe(Effect.map((result) => expect(result.variant).toBe("default"))),
)

it.live("provider-normalized default true remains a documented provenance limitation", () =>
  run((provider) =>
    RayaToolModel.ensure(provider, {
      providerID: ProviderV2.ID.make("local"),
      modelID: ModelV2.ID.make("unspecified"),
    }),
  ).pipe(Effect.map((model) => expect(model.capabilities.toolcall).toBe(true))),
)

it.live("unavailable Auto configuration does not prevent agent discovery", () =>
  provideTmpdirInstance(
    () =>
      Agent.Service.use((agents) => agents.list()).pipe(
        Effect.map((agents) => {
          expect(agents.some((agent) => agent.name === "auto")).toBe(true)
          expect(agents.some((agent) => agent.name !== "auto")).toBe(true)
          expect(agents.find((agent) => agent.name === "auto")?.model).toEqual({
            providerID: ProviderV2.ID.make("absent"),
            modelID: ModelV2.ID.make("small"),
          })
        }),
      ),
    { config: { ...config, small_model: "absent/small" } },
  ),
)
