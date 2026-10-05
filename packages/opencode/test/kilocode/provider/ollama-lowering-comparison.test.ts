import { afterAll, expect } from "bun:test"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { Effect } from "effect"
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
import { SessionID, MessageID } from "@/session/schema"
import { disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
const previous = process.env.KILO_DISABLE_MODELS_FETCH
process.env.KILO_DISABLE_MODELS_FETCH = "1"
const marker = "LOWERING_SYNTHETIC_café_日本語"
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
type Row = {
  model: string
  messages: { role: string; content: string }[]
  think: boolean
  shift: boolean
  truncate: boolean
  options: Record<string, unknown>
}
const rows: Row[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/chat")
    const bytes = await request.arrayBuffer()
    expect(bytes.byteLength).toBeLessThan(65536)
    rows.push(JSON.parse(new TextDecoder().decode(bytes)))
    return new Response(
      JSON.stringify({
        model: "fixture",
        message: { role: "assistant", content: "SYNTHETIC_TRANSPORT_OK" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 8,
        eval_count: 3,
      }) + "\n",
      { headers: { "content-type": "application/x-ndjson" } },
    )
  },
})
const provider = {
  npm: "@ai-sdk/openai-compatible",
  options: { baseURL: `${server.url}v1`, localInference: true, localInferenceAPI: "ollama" as const },
  models: {
    fixture: {
      name: "Synthetic fixture",
      limit: { context: 32768, output: 1024 },
      options: { reasoningEffort: "none" },
    },
  },
}
const config = {
  formatter: false as const,
  lsp: false as const,
  enabled_providers: ["openai", "local"],
  provider: { openai: provider, local: structuredClone(provider) },
}
const flags = LayerNode.make({
  service: RuntimeFlags.Service,
  layer: RuntimeFlags.layer({ experimentalNativeLlm: true, experimentalEventSystem: true }),
  deps: [],
})
const run = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, LLM.node, CrossSpawnSpawner.node, RuntimeFlags.node]), [
    [RuntimeFlags.node, flags],
  ]),
)
run.instance(
  "actual native and SDK lowering preserves synthetic user and system semantics with None wire",
  () =>
    Effect.gen(function* () {
      const service = yield* Provider.Service
      const llm = yield* LLM.Service
      for (const name of ["openai", "local"]) {
        const id = ProviderV2.ID.make(name)
        const model = yield* service.getModel(id, ModelV2.ID.make("fixture"))
        expect(model.options.reasoningEffort).toBe("none")
        expect(LLMNativeRuntime.status({ model, provider: yield* service.getProvider(id), auth: undefined }).type).toBe(
          name === "openai" ? "supported" : "unsupported",
        )
        const session = SessionID.make("ses_synthetic_lowering_" + name)
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
              model: { providerID: id, modelID: model.id },
            },
            agent: {
              name: "fixture",
              mode: "primary",
              permission: [],
              options: {},
              hidden: true,
              prompt: "SYNTHETIC SYSTEM HEADER",
            },
            system: ["SYNTHETIC SYSTEM ROW A", "SYNTHETIC SYSTEM ROW B"],
            messages: [{ role: "user", content: marker }],
            tools: {},
            toolChoice: "none",
            retries: 0,
          })
          .pipe(Stream.runCollect)
        expect(
          events
            .filter(LLMEvent.is.textDelta)
            .map((event) => event.text)
            .join(""),
        ).toBe("SYNTHETIC_TRANSPORT_OK")
      }
      expect(rows).toHaveLength(2)
      const native = rows[0]
      const sdk = rows[1]
      for (const row of rows) {
        expect(row.model).toBe("fixture")
        expect(row.think).toBe(false)
        expect(row.shift).toBe(false)
        expect(row.truncate).toBe(false)
        expect(row.options.num_predict).toBe(1024)
        expect(row.messages.filter((message) => message.role !== "system")).toEqual([{ role: "user", content: marker }])
        expect(row.messages.at(-1)).toEqual({ role: "user", content: marker })
        expect(row.messages.slice(0, -1).every((message) => message.role === "system")).toBe(true)
      }
      expect(native.options).toEqual(sdk.options)
      expect(native.messages.filter((message) => message.role === "system")).toHaveLength(1)
      expect(sdk.messages.filter((message) => message.role === "system")).toHaveLength(2)
      const text = (row: Row) =>
        row.messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n")
      expect(text(native)).toBe(text(sdk))
      expect(text(native)).toContain("SYNTHETIC SYSTEM HEADER\nSYNTHETIC SYSTEM ROW A\nSYNTHETIC SYSTEM ROW B")
      const output = process.env.RAYA_LOWERING_REPORT
      if (output)
        yield* Effect.promise(() =>
          writeFile(
            output,
            JSON.stringify(
              {
                format: "raya.synthetic-lowering-comparison",
                passed: true,
                modelInference: false,
                requests: rows.map((row, index) => ({
                  branch: index === 0 ? "native" : "sdk",
                  model: row.model,
                  think: row.think,
                  options: row.options,
                  roles: row.messages.map((message) => message.role),
                  contentSHA: row.messages.map((message) => hash(message.content)),
                  systemSHA: hash(text(row)),
                  userSHA: hash(row.messages.at(-1)!.content),
                })),
                bounds: { requestBytes: 65536, requests: 2, testMilliseconds: 45000 },
                qualification:
                  "Real production LLM prepare/native and SDK HTTP paths against loopback synthetic responder; not model acceptance.",
              },
              null,
              2,
            ),
            { flag: "wx", mode: 0o600 },
          ),
        )
    }),
  { config },
  45000,
)
afterAll(async () => {
  await server.stop(true)
  await disposeAllInstances()
  if (previous === undefined) delete process.env.KILO_DISABLE_MODELS_FETCH
  else process.env.KILO_DISABLE_MODELS_FETCH = previous
})
