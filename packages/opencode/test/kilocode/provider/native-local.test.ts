import { afterAll, afterEach, expect } from "bun:test"
import { Cause, Effect, Exit, Stream } from "effect"
import { jsonSchema, tool } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LLMEvent } from "@opencode-ai/llm"
import { Provider } from "../../../src/provider/provider"
import { LLM } from "../../../src/session/llm"
import { LLMNativeRuntime } from "../../../src/session/llm/native-runtime"
import { SessionID, MessageID } from "../../../src/session/schema"
import { disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { isRecord } from "../../../src/util/record"

const requests: { path: string; auth: string | null; model: string }[] = []
const calls: unknown[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body: unknown = await request.json()
    if (!isRecord(body) || typeof body.model !== "string") return new Response("Invalid fixture request", { status: 400 })
    const path = new URL(request.url).pathname
    requests.push({ path, auth: request.headers.get("authorization"), model: body.model })
    const parts = path.includes("incomplete")
      ? ["Ready. ", '<｜｜DSML｜｜calls><｜｜DSML｜｜invoke name="lookup">']
      : [
          "Ready. <｜｜DS",
          'ML｜｜calls><｜｜DSML｜｜invoke name="lookup"><｜｜DSML｜｜parameter name="query" string="true">weather',
          "</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls>",
        ]
    const chunk = (content: string | null, finish: string | null) => ({
      id: "local-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
    })
    return new Response(
      [...parts.map((part) => chunk(part, null)), chunk(null, "stop")]
        .map((part) => `data: ${JSON.stringify(part)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const id = ProviderV2.ID.make("local-native-fixture")
const model = ModelV2.ID.make("deepseek-fixture")
const config = (mode: "split" | "incomplete" | "unsupported" | "cloud") => ({
  formatter: false as const,
  lsp: false as const,
  model: `${id}/${model}`,
  enabled_providers: [String(id)],
  provider: {
    [id]: {
      npm: "@ai-sdk/openai-compatible",
      api: `${server.url}${mode}/v1`,
      options: {
        ...(mode === "cloud" ? {} : { localInference: true }),
        ...(mode === "unsupported" ? {} : { baseURL: `${server.url}${mode}/v1` }),
      },
      models: { [model]: { name: "DeepSeek fixture", limit: { context: 8192, output: 1024 }, tool_call: true } },
    },
  },
})
const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, LLM.node, CrossSpawnSpawner.node])))

afterEach(async () => {
  requests.length = 0
  calls.length = 0
  await disposeAllInstances()
})
afterAll(() => server.stop(true))

const collect = Effect.fn("NativeLocalTest.collect")(function* () {
  const provider = yield* Provider.Service
  const llm = yield* LLM.Service
  const selected = yield* provider.getModel(id, model)
  const session = SessionID.make("ses_local_native_fixture")
  return yield* llm
    .stream({
      sessionID: session,
      model: selected,
      user: {
        id: MessageID.ascending(),
        sessionID: session,
        role: "user",
        time: { created: Date.now() },
        agent: "fixture",
        model: { providerID: id, modelID: model },
      },
      agent: { name: "fixture", mode: "primary", permission: [], options: {}, hidden: true },
      system: [],
      messages: [{ role: "user", content: "Check the weather" }],
      retries: 0,
      tools: {
        lookup: tool({
          description: "Lookup fixture data",
          inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
          execute: async (input) => {
            calls.push(input)
            return { output: "fixture result" }
          },
        }),
      },
    })
    .pipe(Stream.runCollect)
})

it.instance(
  "keyless local DeepSeek dispatches split DSML without auth or protocol text",
  () =>
    Effect.gen(function* () {
      const events = yield* collect()
      expect(requests).toEqual([{ path: "/split/v1/chat/completions", auth: null, model: String(model) }])
      expect(calls).toEqual([{ query: "weather" }])
      expect(events.filter(LLMEvent.is.toolCall)).toHaveLength(1)
      expect(events.filter(LLMEvent.is.toolResult)).toHaveLength(1)
      expect(
        events
          .filter(LLMEvent.is.textDelta)
          .map((event) => event.text)
          .join(""),
      ).toBe("Ready. ")
      expect(JSON.stringify(events)).not.toContain("DSML")
    }),
  { config: config("split") },
  30_000,
)

it.instance(
  "incomplete local DSML is suppressed and cannot dispatch a tool",
  () =>
    Effect.gen(function* () {
      const events = yield* collect()
      expect(requests).toHaveLength(1)
      expect(requests[0]?.auth).toBeNull()
      expect(calls).toEqual([])
      expect(events.filter(LLMEvent.is.toolCall)).toHaveLength(0)
      expect(JSON.stringify(events)).not.toContain("DSML")
    }),
  { config: config("incomplete") },
  30_000,
)

it.instance(
  "unsupported explicitly local DSML fails before any SDK fallback request",
  () =>
    Effect.gen(function* () {
      const result = yield* collect().pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("LocalNativeError")
      expect(requests).toEqual([])
      expect(calls).toEqual([])
    }),
  { config: config("unsupported") },
  30_000,
)

it.instance(
  "a compatible endpoint without local opt-in retains native credential refusal",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const selected = yield* provider.getModel(id, model)
      const item = yield* provider.getProvider(id)
      expect(LLMNativeRuntime.status({ model: selected, provider: item, auth: undefined })).toEqual({
        type: "unsupported",
        reason: "API key is not configured",
      })
      expect(requests).toEqual([])
    }),
  { config: config("cloud") },
  30_000,
)
