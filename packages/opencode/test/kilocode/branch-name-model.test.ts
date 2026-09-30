import { afterAll, afterEach, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

const requests: string[] = []
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await Schema.decodeUnknownPromise(
      Schema.Struct({ model: Schema.String, stream: Schema.optional(Schema.Boolean) }),
    )(await request.json())
    requests.push(body.model)
    const chunk = {
      id: "branch-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta: { content: "fix-local-model-routing" }, finish_reason: null }],
    }
    if (!body.stream) return new Response("Expected streaming inference", { status: 400 })
    return new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
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
const it = testEffect(httpApiLayer)

afterEach(async () => {
  requests.length = 0
  await disposeAllInstances()
})
afterAll(() => server.stop(true))

function name(selection: { providerID?: string; modelID?: string }) {
  return Effect.gen(function* () {
    const instance = yield* TestInstance
    const created = yield* requestInDirectory("/session", instance.directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Private branch task" }),
    })
    expect(created.status).toBe(200)
    const session = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(yield* created.json)
    const response = yield* requestInDirectory(`/session/${session.id}/branch-name`, instance.directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Fix local model routing", ...selection }),
    })
    expect(response.status).toBe(200)
    return yield* response.json
  })
}

it.instance(
  "branch naming transmits only to the exact selected local model",
  () =>
    name({ providerID: "local", modelID: "main-9b" }).pipe(
      Effect.map((result) => {
        expect(result).toEqual({ branch: "fix-local-model-routing" })
        expect(requests).toEqual(["main-9b"])
      }),
    ),
  { config },
  30_000,
)

it.instance(
  "legacy branch naming retains the configured small model",
  () =>
    name({}).pipe(
      Effect.map((result) => {
        expect(result).toEqual({ branch: "fix-local-model-routing" })
        expect(requests).toEqual(["small"])
      }),
    ),
  { config },
  30_000,
)

it.instance(
  "an unavailable exact model never falls back to the global model",
  () =>
    name({ providerID: "local", modelID: "missing" }).pipe(
      Effect.map((result) => {
        expect(result).toEqual({ branch: null })
        expect(requests).toEqual([])
      }),
    ),
  { config },
  30_000,
)

for (const selection of [
  { providerID: "local" },
  { modelID: "main-9b" },
  { providerID: "", modelID: "main-9b" },
  { providerID: "local", modelID: "" },
]) {
  it.instance(
    `incomplete branch model selection refuses ${JSON.stringify(selection)}`,
    () =>
      name(selection).pipe(
        Effect.map((result) => {
          expect(result).toEqual({ branch: null })
          expect(requests).toEqual([])
        }),
      ),
    { config },
    30_000,
  )
}
