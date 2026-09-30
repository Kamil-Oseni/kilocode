import { afterAll, afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "../../src/provider/provider"
import { resolveEnhanceModel } from "../../src/kilocode/enhance-prompt"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

const requests: string[] = []
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { model: string }
    requests.push(body.model)
    return Response.json({
      id: "fixture",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Improved local draft" } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    })
  },
})
const entry = { name: "Fixture", limit: { context: 8192, output: 1024 } }
const config = {
  formatter: false as const,
  lsp: false as const,
  model: "other/cloud",
  small_model: "other/small",
  enabled_providers: ["local", "other"],
  provider: {
    local: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${server.url}v1` }, models: { "main-9b": entry } },
    other: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${server.url}v1` },
      models: { cloud: entry, small: entry },
    },
  },
}
const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Provider.node, CrossSpawnSpawner.node])), httpApiLayer),
)

afterEach(async () => {
  requests.length = 0
  await disposeAllInstances()
})
afterAll(() => server.stop(true))

it.instance(
  "exact selection bypasses global default and small model",
  () =>
    Provider.Service.use((provider) =>
      resolveEnhanceModel(provider, { providerID: "local", modelID: "main-9b" }).pipe(
        Effect.map((model) => {
          expect(model.providerID).toBe(ProviderV2.ID.make("local"))
          expect(model.id).toBe(ModelV2.ID.make("main-9b"))
        }),
      ),
    ),
  { config },
  30_000,
)

it.instance(
  "legacy calls retain the configured small model",
  () =>
    Provider.Service.use((provider) =>
      resolveEnhanceModel(provider).pipe(
        Effect.map((model) => {
          expect(model.providerID).toBe(ProviderV2.ID.make("other"))
          expect(model.id).toBe(ModelV2.ID.make("small"))
        }),
      ),
    ),
  { config },
  30_000,
)

it.instance(
  "HTTP enhancement transmits only to the explicitly selected model",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const response = yield* requestInDirectory("/enhance-prompt", instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Improve this draft", model: { providerID: "local", modelID: "main-9b" } }),
      })
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ text: "Improved local draft" })
      expect(requests).toEqual(["main-9b"])
    }),
  { config },
  30_000,
)

it.instance(
  "missing explicit model refuses without a default or small-model request",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const result = yield* Provider.Service.use((provider) =>
        resolveEnhanceModel(provider, { providerID: "local", modelID: "missing" }).pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
      const response = yield* requestInDirectory("/enhance-prompt", instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Private draft", model: { providerID: "local", modelID: "missing" } }),
      })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(requests).toEqual([])
    }),
  { config },
  30_000,
)

it.instance(
  "malformed explicit selection fails instead of behaving like an omitted selection",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const response = yield* requestInDirectory("/enhance-prompt", instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Private draft", model: { providerID: "local", modelID: "" } }),
      })
      expect(response.status).toBe(400)
      expect(requests).toEqual([])
    }),
  { config },
  30_000,
)
