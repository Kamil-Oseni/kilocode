import { afterAll, expect, test } from "bun:test"
import { jsonSchema, tool, streamText, wrapLanguageModel, type ModelMessage } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Cause, Effect, Exit } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent } from "@opencode-ai/llm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { LLM } from "@/session/llm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionID, MessageID } from "@/session/schema"
import { effective } from "@/kilocode/provider/ollama-context"
import * as Prompt from "@/kilocode/provider/ollama-prompt"
import { ollama } from "@/kilocode/provider/ollama-bridge"
import { LazyTools } from "@/kilocode/session/lazy-tools"
import * as MemoryContext from "@/kilocode/second-brain/context"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import { KiloLLM } from "@/kilocode/session/llm"
import { disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const previous = process.env.KILO_DISABLE_MODELS_FETCH
process.env.KILO_DISABLE_MODELS_FETCH = "1"
const id = "gemma-context-fixture"
const rows: Array<{
  model: string
  messages: ReturnType<typeof Prompt.project>
  options: { num_ctx: number; num_predict: number }
  tools?: unknown
  format?: unknown
  shift: boolean
  truncate: boolean
}> = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/chat")
    const bytes = await request.arrayBuffer()
    expect(bytes.byteLength).toBeLessThan(2 * 1024 * 1024)
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as (typeof rows)[number]
    rows.push(data)
    return new Response(
      JSON.stringify({
        model: data.model,
        message: { role: "assistant", content: JSON.stringify({ kind: "text", content: "Synthetic bounded reply" }) },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 8,
        eval_count: 4,
      }) + "\n",
      { headers: { "content-type": "application/x-ndjson" } },
    )
  },
})
const options = {
  baseURL: `${server.url}v1`,
  localInference: true,
  localInferenceAPI: "ollama" as const,
  localInferenceContext: 32768,
  localInferenceToolFormat: "completion-envelope-v1",
}
const flags = LayerNode.make({
  service: RuntimeFlags.Service,
  layer: RuntimeFlags.layer({ experimentalNativeLlm: false, experimentalEventSystem: true, outputTokenMax: 32768 }),
  deps: [],
})
const run = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, LLM.node, CrossSpawnSpawner.node, RuntimeFlags.node]), [
    [RuntimeFlags.node, flags],
  ]),
)
const tools = {
  question: tool({
    description: "Actual synthetic question schema",
    inputSchema: jsonSchema({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    }),
  }),
  huge_catalog: tool({
    description: "Retained schema ".repeat(30000),
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
  }),
}
run.instance(
  "explicit native context0 uses the same window for real schema selection, preflight and output",
  () =>
    Effect.gen(function* () {
      const service = yield* Provider.Service
      const llm = yield* LLM.Service
      const model = yield* service.getModel(ProviderV2.ID.make("gemma-fixture"), ModelV2.ID.make(id))
      expect(model.limit.context).toBe(32768)
      expect(model.limit.output).toBe(1024)
      expect(effective({}, { ...model, limit: { ...model.limit, context: 0 } }).limit.context).toBe(0)
      expect(effective(options, { ...model, limit: { ...model.limit, context: 0, output: 65536 } }).limit.output).toBe(
        32768,
      )
      expect(() => effective(options, { ...model, limit: { ...model.limit, context: 0, input: 65536 } })).toThrow(
        "input limit exceeds",
      )
      expect(() => effective(options, { ...model, limit: { ...model.limit, input: 65536 } })).toThrow(
        "input limit exceeds",
      )
      expect(
        effective({ ...options, localInferenceContext: undefined }, { ...model, limit: { ...model.limit, context: 0 } })
          .limit.context,
      ).toBe(0)
      expect(() => effective({ ...options, localInferenceContext: 65536 }, model)).toThrow(
        "Explicit local context differs",
      )
      for (const context of [NaN, Infinity, -1, 2048.5])
        expect(() => effective({ ...options, localInferenceContext: context }, model)).toThrow(
          "Invalid explicit local model context",
        )
      const session = SessionID.make("ses_explicit_native_context")
      const owner = MemoryContext.create()
      const input = {
        model: { ...model, limit: { ...model.limit, context: 0, input: 32768 } },
        sessionID: session,
        user: {
          id: MessageID.ascending(),
          sessionID: session,
          role: "user" as const,
          time: { created: Date.now() },
          agent: "voice",
          model: { providerID: model.providerID, modelID: model.id },
        },
        agent: {
          name: "voice",
          mode: "primary" as const,
          permission: [],
          options: {},
          hidden: true,
          prompt: "Retain this exact synthetic system instruction.",
        },
        system: ["SYNTHETIC FIXED CONTEXT"],
        messages: [{ role: "user" as const, content: "Voice-first synthetic request " + "a".repeat(60000) }],
        tools: MemoryContext.bind({ ...tools }, owner),
        preflight: true,
        retries: 0,
        toolChoice: "auto" as const,
      }
      const events = yield* llm.stream(input).pipe(Stream.runCollect)
      expect(
        events
          .filter(LLMEvent.is.textDelta)
          .map((row) => row.text)
          .join(""),
      ).toBe("Synthetic bounded reply")
      expect(rows).toHaveLength(1)
      const reserve = yield* Effect.exit(
        llm.stream({ ...input, tools: {}, reportedContextTokens: 32768 - 512 }).pipe(Stream.runDrain),
      )
      expect(Exit.isFailure(reserve)).toBe(true)
      if (Exit.isFailure(reserve)) expect(Cause.pretty(reserve.cause)).toContain("automatic compaction threshold")
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row.options).toMatchObject({ num_ctx: 32768, num_predict: 1024 })
      expect(row.shift).toBe(false)
      expect(row.truncate).toBe(false)
      expect(row.tools).toBeUndefined()
      expect(row.format).toBeDefined()
      const system = row.messages
        .filter((row) => row.role === "system")
        .map((row) => row.content)
        .join("\n")
      expect(system).toContain("SYNTHETIC FIXED CONTEXT")
      expect(system).toContain("discover_tools")
      expect(system).not.toContain("Retained schema ".repeat(100))
      expect(Prompt.measure(row.messages, []).normalized + row.options.num_predict).toBeLessThanOrEqual(
        row.options.num_ctx,
      )
      expect(owner.reserve(12000, new AbortController().signal).budget).toBe(
        Math.min(12000, row.options.num_ctx - Prompt.measure(row.messages, []).raw - row.options.num_predict - 1024),
      )
      const history = yield* Effect.exit(
        llm
          .stream({ ...input, tools: {}, messages: [{ role: "user", content: "Retained history ".repeat(20000) }] })
          .pipe(Stream.runDrain),
      )
      expect(Exit.isFailure(history)).toBe(true)
      if (Exit.isFailure(history)) expect(Cause.pretty(history.cause)).toContain("automatic compaction threshold")
      const fixed = yield* Effect.exit(
        llm.stream({ ...input, tools: {}, system: ["Irreducible fixed system ".repeat(20000)] }).pipe(Stream.runDrain),
      )
      expect(Exit.isFailure(fixed)).toBe(true)
      if (Exit.isFailure(fixed)) expect(Cause.pretty(fixed.cause)).toContain("fixed system prompt")
      for (const mode of [false, true]) {
        const large = { ...input.model, limit: { ...input.model.limit, output: 32768 } }
        const failed = yield* Effect.exit(
          llm
            .stream({
              ...input,
              model: large,
              tools: {},
              ...(mode
                ? { system: ["Irreducible canonical fixed context ".repeat(20000)] }
                : { messages: [{ role: "user", content: "Removable canonical history ".repeat(20000) }] }),
            })
            .pipe(Stream.runDrain),
        )
        expect(Exit.isFailure(failed)).toBe(true)
        if (Exit.isFailure(failed))
          expect(Cause.pretty(failed.cause)).toContain(mode ? "fixed system prompt" : "automatic compaction threshold")
        expect(rows).toHaveLength(1)
      }
      expect(rows).toHaveLength(1)
    }),
  {
    config: {
      formatter: false,
      lsp: false,
      compaction: { auto: false },
      enabled_providers: ["gemma-fixture"],
      provider: {
        "gemma-fixture": {
          npm: "@ai-sdk/openai-compatible",
          options,
          models: {
            [id]: {
              name: "Synthetic Gemma-family context fixture; no weights",
              tool_call: true,
              options: { reasoningEffort: "none" },
              limit: { context: 0, output: 1024 },
            },
          },
        },
      },
    },
  },
  45000,
)

test("final native envelope/history estimate and full output reserve refuse before loopback POST at the boundary", async () => {
  const definitions = [
    {
      type: "function" as const,
      function: {
        name: "question",
        description: "Retained function",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    },
  ]
  const messages = [
    { role: "system" as const, content: "Retain the exact fixed instructions. ".repeat(40) },
    {
      role: "assistant" as const,
      content: "",
      tool_calls: [
        { type: "function" as const, id: "original", function: { name: "question", arguments: '{"text":"original"}' } },
      ],
    },
    { role: "tool" as const, tool_call_id: "original", content: 'Retained escaped history\\"\n'.repeat(500) },
    { role: "user" as const, content: "Final synthetic request" },
  ]
  const projected = Prompt.project(messages, definitions, true, "auto")
  const context = Prompt.measure(projected, []).normalized + 1024
  expect(context).toBeGreaterThanOrEqual(2048)
  const before = rows.length
  const body = JSON.stringify({
    model: id,
    messages,
    tools: definitions,
    tool_choice: "auto",
    stream: false,
    max_tokens: 1024,
  })
  const accepted = await ollama({ ...options, localInferenceContext: context }, fetch)(
    `${server.url}v1/chat/completions`,
    { method: "POST", body },
  )
  await accepted.text()
  expect(rows).toHaveLength(before + 1)
  expect(rows.at(-1)?.messages).toEqual(projected)
  await expect(
    ollama({ ...options, localInferenceContext: context - 1 }, fetch)(`${server.url}v1/chat/completions`, {
      method: "POST",
      body,
    }),
  ).rejects.toBeInstanceOf(Prompt.OllamaWindowError)
  await expect(
    ollama({ ...options, localInferenceContext: context }, fetch)(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: id, messages, tools: definitions, tool_choice: "auto", stream: false }),
    }),
  ).rejects.toBeInstanceOf(Prompt.OllamaWindowError)
  expect(rows).toHaveLength(before + 1)
})

run.instance(
  "native envelope capacity selects the actual discovery catalog even with a larger context window",
  () =>
    Effect.gen(function* () {
      const service = yield* Provider.Service
      const original = yield* service.getModel(ProviderV2.ID.make("gemma-fixture"), ModelV2.ID.make(id))
      const model = { ...original, limit: { ...original.limit, context: 262144 } }
      const selected = yield* Effect.promise(() =>
        LazyTools.select({
          agent: "voice",
          mode: "primary",
          tools,
          system: ["Retain the fixed instructions"],
          model,
          options: { ...options, localInferenceContext: 262144 },
        }),
      )
      expect(Object.keys(selected)).toContain("discover_tools")
      expect(Object.keys(selected)).not.toContain("huge_catalog")
      yield* Effect.promise(async () => {
        await expect(
          Prompt.prepare(options, model, [{ role: "user", content: "Synthetic request" }], tools),
        ).rejects.toBeInstanceOf(Prompt.OllamaWindowError)
      })
    }),
  {
    config: {
      formatter: false,
      lsp: false,
      enabled_providers: ["gemma-fixture"],
      provider: {
        "gemma-fixture": {
          npm: "@ai-sdk/openai-compatible",
          options,
          models: {
            [id]: {
              name: "Synthetic context fixture; no weights",
              tool_call: true,
              limit: { context: 0, output: 1024 },
            },
          },
        },
      },
    },
  },
  45000,
)

test("native envelope count capacity discovers 129 valid tools even without a known context", async () => {
  const catalog = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => [
      `fixture_${index}`,
      tool({ description: "Fixture", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
    ]),
  )
  for (const context of [32768, 0]) {
    const selected = await LazyTools.select({
      agent: "voice",
      mode: "primary",
      tools: catalog,
      system: ["Retain fixed instructions"],
      model: {
        id,
        providerID: "gemma-fixture",
        api: { id, npm: "@ai-sdk/openai-compatible" },
        capabilities: { input: { text: true } },
        limit: { context, output: 1024 },
      } as Provider.Model,
      options: { ...options, localInferenceContext: context || undefined },
    })
    // The actual native projection is selected through the concrete SDK package.
    // No loader execution or model inference is claimed by this schema test.
    expect(Object.keys(selected)).toEqual(["discover_tools"])
  }
  const definitions = Array.from({ length: 129 }, (_, index) => ({
    function: { name: `fixture_${index}`, parameters: {} },
  }))
  expect(() => Prompt.format(definitions, "auto")).toThrow(Prompt.OllamaWindowError)
  expect(() =>
    Prompt.format(
      definitions.map((row) => ({ ...row, function: { ...row.function, name: "duplicate" } })),
      "auto",
    ),
  ).toThrow("Invalid envelope tool definitions")
  expect(() =>
    Prompt.format(
      definitions.map((row, index) => (index ? row : { function: { name: "", parameters: {} } })),
      "auto",
    ),
  ).toThrow("Invalid envelope tool definitions")
})

test("canonical native preparation matches real SDK Mistral and interleaved history transformation", async () => {
  for (const fixture of ["mistral-fixture", "interleaved-fixture"]) {
    const model = {
      id: fixture,
      providerID: "gemma-fixture",
      api: { id: fixture, npm: "@ai-sdk/openai-compatible" },
      capabilities: {
        input: { text: true },
        interleaved: fixture === "interleaved-fixture" ? { field: "reasoning_content" } : false,
      },
      limit: { context: 32768, output: 1024 },
    } as Provider.Model
    const messages: ModelMessage[] = [
      { role: "system", content: "Retain exact fixed instructions" },
      { role: "user", content: "Read the actual fixture" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Retained synthetic reasoning" },
          { type: "tool-call", toolCallId: "fixture_original_123", toolName: "question", input: { text: "literal" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "fixture_original_123",
            toolName: "question",
            output: { type: "text", value: "Actual fixture output" },
          },
        ],
      },
      { role: "user", content: "Continue from the tool result" },
    ]
    const original = structuredClone(messages)
    const selected = { question: tools.question }
    const transform = { store: false }
    const prepared = await Prompt.prepare(options, model, messages, selected, "auto", transform)
    if (!prepared) throw new Error("Actual native prompt projection required")
    expect(messages).toEqual(original)
    const provider = createOpenAICompatible({
      name: "fixture",
      baseURL: `${server.url}v1`,
      fetch: Object.assign(ollama({ ...options, ollamaModel: fixture, ollamaContext: 32768 }, fetch), {
        preconnect: fetch.preconnect,
      }),
    })
    const before = rows.length
    const stream = streamText({
      model: wrapLanguageModel({
        model: provider.chatModel(fixture),
        middleware: {
          specificationVersion: "v3",
          transformParams: async (args) => {
            const adapted = ProviderTransform.message(args.params.prompt as unknown as ModelMessage[], model, transform)
            return { ...args.params, prompt: adapted as unknown as typeof args.params.prompt }
          },
        },
      }),
      messages,
      tools: selected,
      toolChoice: "auto",
      maxOutputTokens: 1024,
      maxRetries: 0,
    })
    expect(await stream.text).toBe("Synthetic bounded reply")
    expect(rows).toHaveLength(before + 1)
    expect(rows.at(-1)?.messages).toEqual(prepared.messages)
    expect(Prompt.measure(rows.at(-1)!.messages, []).normalized).toBe(prepared.usage.normalized)
    if (fixture === "mistral-fixture")
      expect(rows.at(-1)?.messages.some((row) => row.role === "assistant" && row.content === "Done.")).toBe(true)
  }
})

test("native recall rejects malformed output capacity without adopting the declared input allowance", () => {
  for (const output of [undefined, NaN, Infinity, -1, 1024.5]) {
    const owner = MemoryContext.create()
    const selected = MemoryContext.bind({ question: tools.question }, owner)
    MemoryContext.prepare({
      originals: selected,
      tools: selected,
      messages: [{ role: "user", content: "Actual bounded fixture" }],
      context: 32768,
      output: 0,
      native: { context: 32768, output },
    })
    expect(() => owner.reserve(12000, new AbortController().signal)).toThrow("allowance is unavailable")
  }
})

test("canonical exhausted history keeps a positive native reserve without misclassifying fixed input", () => {
  const messages = Prompt.project(
    [
      { role: "system", content: "Fixed synthetic instruction" },
      { role: "user", content: "Removable synthetic history ".repeat(20000) },
    ],
    [],
    true,
    "auto",
  )
  const model = {
    id,
    providerID: "gemma-fixture",
    api: { id, npm: "@ai-sdk/openai-compatible" },
    limit: { context: 32768, input: 32768, output: 32768 },
  } as Provider.Model
  const input = { model, messages, tools: {}, configured: model.limit.output, usage: Prompt.measure(messages, []) }
  expect(KiloLLM.capOutputTokens(input)).toBe(32768)
  const output = KiloLLM.capOutputTokens({ ...input, native: true })
  expect(output).toBe(1024)
  const checked = KiloSessionOverflow.preflight({
    ...input,
    cfg: { compaction: { auto: false } },
    usable: model.limit.context,
    output,
    native: true,
  })
  expect(checked.compact).toBe(true)
  expect(checked.irreducible).toBe(false)
  const fixed = Prompt.project(
    [{ role: "system", content: "Irreducible fixed instruction ".repeat(20000) }],
    [],
    true,
    "auto",
  )
  const capped = KiloLLM.capOutputTokens({ ...input, messages: fixed, usage: Prompt.measure(fixed, []), native: true })
  expect(capped).toBe(1)
  expect(
    KiloSessionOverflow.preflight({
      ...input,
      messages: fixed,
      cfg: {},
      usable: model.limit.context,
      output: capped,
      native: true,
    }).irreducible,
  ).toBe(true)
  const required = KiloSessionOverflow.measure({
    messages: messages.filter((row) => row.role === "system"),
    tools: {},
  }).normalized
  const tiny = { ...model, limit: { context: required + 32, input: required + 32, output: required + 32 } }
  const small = KiloLLM.capOutputTokens({ ...input, model: tiny, configured: tiny.limit.output, native: true })
  expect(small).toBe(31)
  const reduced = KiloSessionOverflow.preflight({
    ...input,
    model: tiny,
    cfg: {},
    usable: tiny.limit.context,
    output: small,
    native: true,
  })
  expect(reduced.compact).toBe(true)
  expect(reduced.irreducible).toBe(false)
  for (const configured of [undefined, NaN, Infinity, 0, -1, 1024.5])
    expect(() => KiloLLM.capOutputTokens({ ...input, configured, native: true })).toThrow(
      "positive finite output budget",
    )
})

test("native preflight reserves actual output even when the declared input equals its context", () => {
  const messages = [{ role: "user", content: "Actual declared-input boundary ".repeat(180) }]
  const usage = KiloSessionOverflow.measure({ messages, tools: {} }).normalized
  const model = {
    id,
    providerID: "gemma-fixture",
    api: { id, npm: "@ai-sdk/openai-compatible" },
    limit: { context: usage + 1024, input: usage + 1024, output: 1024 },
  } as Provider.Model
  const input = {
    cfg: { compaction: { auto: false } },
    model,
    usable: model.limit.context,
    messages,
    tools: {},
    output: 1024,
  }
  expect(KiloSessionOverflow.preflight(input).compact).toBe(false)
  const refused = KiloSessionOverflow.preflight({ ...input, native: true })
  expect(refused.compact).toBe(true)
  expect(refused.irreducible).toBe(false)
  expect(refused.output).toBe(1024)
  const available = {
    ...model,
    limit: { ...model.limit, context: model.limit.context + 1, input: usage + 1025 },
  }
  expect(KiloSessionOverflow.preflight({ ...input, model: available, native: true }).compact).toBe(false)
  const separate = { ...model, limit: { ...model.limit, context: model.limit.context + 4096, input: usage + 1 } }
  expect(KiloSessionOverflow.preflight({ ...input, model: separate, native: true }).compact).toBe(false)
  for (const output of [undefined, NaN, Infinity, 0, -1, 1024.5])
    expect(() => KiloSessionOverflow.preflight({ ...input, output, native: true })).toThrow(
      "positive finite output reserve",
    )
})

afterAll(async () => {
  await server.stop(true)
  await disposeAllInstances()
  if (previous === undefined) delete process.env.KILO_DISABLE_MODELS_FETCH
  else process.env.KILO_DISABLE_MODELS_FETCH = previous
})
