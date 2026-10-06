import { afterAll, expect } from "bun:test"
import { writeFile } from "node:fs/promises"
import { jsonSchema, tool } from "ai"
import { Effect, Schema } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent } from "@opencode-ai/llm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const previous = process.env.KILO_DISABLE_MODELS_FETCH
process.env.KILO_DISABLE_MODELS_FETCH = "1"
const id = "qwen3.5-9b-pinned:6488c96fa5fa"
const marker = "SYNTHETIC_QWEN_ENVELOPE_WIRE"
const wire = Schema.Struct({
  model: Schema.String,
  think: Schema.Boolean,
  stream: Schema.Boolean,
  shift: Schema.Boolean,
  truncate: Schema.Boolean,
  format: Schema.Struct({ anyOf: Schema.Array(Schema.Unknown) }),
  options: Schema.Struct({ num_ctx: Schema.Number, num_predict: Schema.Number }),
})
const rows: Schema.Schema.Type<typeof wire>[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/chat")
    const bytes = await request.arrayBuffer()
    expect(bytes.byteLength).toBeLessThan(65536)
    expect(rows.length).toBeLessThan(2)
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
    rows.push(Schema.decodeUnknownSync(wire)(body))
    expect(body).not.toHaveProperty("tools")
    const content = JSON.stringify({ kind: "tool", name: "update_goal", arguments: { marker } })
    return new Response(
      [
        { model: id, message: { role: "assistant", content }, done: false },
        { model: id, done: true, done_reason: "stop", prompt_eval_count: 32, eval_count: 16 },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
      { headers: { "content-type": "application/x-ndjson" } },
    )
  },
})
const flags = LayerNode.make({
  service: RuntimeFlags.Service,
  layer: RuntimeFlags.layer({ experimentalNativeLlm: false, experimentalEventSystem: true }),
  deps: [],
})
const run = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, LLM.node, CrossSpawnSpawner.node, RuntimeFlags.node]), [
    [RuntimeFlags.node, flags],
  ]),
)
run.instance(
  "actual qwen-local SDK envelope requests preserve None and the 4096-token native budget",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const llm = yield* LLM.Service
      const model = yield* provider.getModel(ProviderV2.ID.make("qwen-local"), ModelV2.ID.make(id))
      expect(model.options.reasoningEffort).toBe("none")
      expect(
        LLMNativeRuntime.status({ model, provider: yield* provider.getProvider(model.providerID), auth: undefined })
          .type,
      ).toBe("unsupported")
      for (const choice of ["auto", "required"] as const) {
        const session = SessionID.make("ses_qwen_envelope_wire_" + choice)
        const events = yield* llm
          .stream({
            model,
            sessionID: session,
            user: {
              id: MessageID.ascending(),
              sessionID: session,
              role: "user",
              time: { created: Date.now() },
              agent: "fixture",
              model: { providerID: model.providerID, modelID: model.id },
            },
            agent: { name: "fixture", mode: "primary", permission: [], options: {}, hidden: true },
            system: ["Synthetic transport fixture; no model inference."],
            messages: [{ role: "user", content: marker }],
            tools: {
              update_goal: tool({
                description: "Synthetic transport marker; does not mutate a Goal.",
                inputSchema: jsonSchema<{ marker: string }>({
                  type: "object",
                  properties: { marker: { type: "string", const: marker } },
                  required: ["marker"],
                  additionalProperties: false,
                }),
              }),
            },
            toolChoice: choice,
            retries: 0,
          })
          .pipe(Stream.runCollect)
        const calls = events.filter(LLMEvent.is.toolCall)
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ name: "update_goal", input: { marker } })
        const row = rows.at(-1)!
        expect(row).toMatchObject({
          model: id,
          think: false,
          stream: true,
          shift: false,
          truncate: false,
          options: { num_ctx: 32768, num_predict: 4096 },
        })
        expect(row.format.anyOf).toHaveLength(choice === "auto" ? 3 : 2)
        expect(row.format.anyOf[0]).toMatchObject({ properties: { name: { const: "update_goal" } } })
        expect(JSON.stringify(row.format)).toContain(marker)
      }
      expect(rows).toHaveLength(2)
      const output = process.env.RAYA_QWEN_WIRE_REPORT
      if (output)
        yield* Effect.promise(() =>
          writeFile(
            output,
            JSON.stringify(
              {
                passed: true,
                modelInference: false,
                requests: rows,
                qualification:
                  "Production LLM/SDK/bridge with a synthetic HTTP response; not actual model output or failed-trial wire capture.",
              },
              null,
              2,
            ) + "\n",
            { flag: "wx", mode: 0o600 },
          ),
        )
    }),
  {
    config: {
      enabled_providers: ["qwen-local"],
      provider: {
        "qwen-local": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `${server.url}v1`,
            localInference: true,
            localInferenceAPI: "ollama",
            localInferenceToolFormat: "completion-envelope-v1",
          },
          models: {
            [id]: {
              name: "Pinned synthetic wire",
              options: { reasoningEffort: "none" },
              limit: { context: 32768, output: 4096 },
            },
          },
        },
      },
    },
  },
  45_000,
)
afterAll(async () => {
  await server.stop(true)
  await disposeAllInstances()
  if (previous === undefined) delete process.env.KILO_DISABLE_MODELS_FETCH
  else process.env.KILO_DISABLE_MODELS_FETCH = previous
})
