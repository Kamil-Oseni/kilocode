import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { Storage } from "@/storage/storage"
import { RayaGoal } from "@/kilocode/goal"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Fiber, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { localFetch } from "@/kilocode/provider/local-scheduler"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { SessionID, MessageID } from "@/session/schema"
import * as Stream from "effect/Stream"
import { LLMError, LLMEvent } from "@opencode-ai/llm"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { tool, jsonSchema, type ModelMessage } from "ai"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { httpApiLayer, requestInDirectory } from "../../server/httpapi-layer"

// Explicit fixture models need no unrelated remote catalog refresh between the two real service graphs.
const previous = process.env.KILO_DISABLE_MODELS_FETCH
process.env.KILO_DISABLE_MODELS_FETCH = "1"
const rows: Record<string, unknown>[] = []
const gate = Promise.withResolvers<void>()
const opened = Promise.withResolvers<void>()
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    expect(new URL(req.url).pathname).toBe("/api/chat")
    const body = await req.json()
    rows.push(body)
    if (body.messages.some((message: { content: string }) => message.content.includes("NATIVE_FAILURE_FIXTURE"))) {
      const overflow = body.messages.some((message: { content: string }) => message.content.includes("OVERFLOW"))
      return Response.json(
        {
          error: overflow
            ? JSON.stringify({
                error: {
                  code: 400,
                  message:
                    "request (33000 tokens) exceeds the available context size (32768 tokens), try increasing it",
                  type: "exceed_context_size_error",
                  n_prompt_tokens: 33000,
                  n_ctx: 32768,
                },
              })
            : "unsupported reasoning effort",
        },
        { status: 400 },
      )
    }
    if (!body.stream)
      return Response.json({
        model: body.model,
        message: { role: "assistant", content: "Improved draft" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 8,
        eval_count: 3,
      })
    if (body.messages.some((message: { content: string }) => message.content.includes("TOOL_CONTINUATION_FIXTURE"))) {
      const continued = body.messages.some((message: { role: string }) => message.role === "tool")
      return new Response(
        [
          {
            model: body.model,
            message: continued
              ? { role: "assistant", content: "CONTINUATION_OK" }
              : {
                  role: "assistant",
                  content: "",
                  thinking: "plan",
                  tool_calls: [{ function: { name: "metadata", arguments: { tag: "METADATA_OK" } } }],
                },
            done: false,
          },
          { model: body.model, done: true, done_reason: "stop", prompt_eval_count: 8, eval_count: 3 },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      )
    }
    return new Response(
      new ReadableStream({
        async start(ctrl) {
          const encoder = new TextEncoder()
          ctrl.enqueue(
            encoder.encode(
              JSON.stringify({
                model: body.model,
                message: { role: "assistant", content: "bridge-branch" },
                done: false,
              }) + "\n",
            ),
          )
          opened.resolve()
          await gate.promise
          ctrl.enqueue(
            encoder.encode(
              JSON.stringify({
                model: body.model,
                done: true,
                done_reason: "stop",
                prompt_eval_count: 8,
                eval_count: 3,
              }) + "\n",
            ),
          )
          ctrl.close()
        },
      }),
    )
  },
})
const config = {
  formatter: false as const,
  lsp: false as const,
  enabled_providers: ["openai"],
  provider: {
    openai: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${server.url}v1`, localInference: true, localInferenceAPI: "ollama" as const },
      models: { fixture: { name: "Fixture", limit: { context: 32768, output: 1024 } } },
    },
  },
}
const it = testEffect(httpApiLayer)
const flags = LayerNode.make({
  service: RuntimeFlags.Service,
  layer: RuntimeFlags.layer({ experimentalNativeLlm: true, experimentalEventSystem: true }),
  deps: [],
})
const native = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, LLM.node, CrossSpawnSpawner.node, RuntimeFlags.node]), [
    [RuntimeFlags.node, flags],
  ]),
)
const persisted = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, SessionPrompt.node, SessionProjector.node, RuntimeFlags.node]), [
    [RuntimeFlags.node, flags],
  ]),
)
persisted.instance(
  "real native Session prompt persists classified overflow and leaves unrelated 400 failures distinct",
  () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      expect((yield* RuntimeFlags.Service).experimentalNativeLlm).toBe(true)
      for (const marker of ["OVERFLOW", "OTHER"]) {
        const offset = rows.length
        const created = yield* session.create({ title: `Native ${marker}` })
        const result = yield* prompt.prompt({
          sessionID: created.id,
          model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("fixture") },
          agent: "generalist",
          tools: {},
          parts: [{ type: "text", text: `NATIVE_FAILURE_FIXTURE ${marker}` }],
        })
        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") throw new Error("Native failure did not publish an assistant")
        expect(MessageV2.ContextOverflowError.isInstance(result.info.error)).toBe(marker === "OVERFLOW")
        const messages = yield* session.messages({ sessionID: created.id })
        const saved = messages.find((message) => message.info.id === result.info.id)
        expect(saved?.info).toEqual(result.info)
        const sent = rows
          .slice(offset)
          .filter((row) => JSON.stringify(row.messages).includes(`NATIVE_FAILURE_FIXTURE ${marker}`))
        // Session title/summary consumers may also read the prompt; their requests are distinct from retrying its turn.
        expect(sent.length).toBeGreaterThan(0)
        for (const row of sent) expect(row).toMatchObject({ shift: false, truncate: false })
      }
    }),
  { config },
  45000,
)
native.instance(
  "actual native HTTP overflow publishes a typed session error without promoting unrelated 400 failures",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const llm = yield* LLM.Service
      const id = ProviderV2.ID.make("openai")
      const model = yield* provider.getModel(id, ModelV2.ID.make("fixture"))
      expect((yield* RuntimeFlags.Service).experimentalNativeLlm).toBe(true)
      expect(LLMNativeRuntime.status({ model, provider: yield* provider.getProvider(id), auth: undefined }).type).toBe(
        "supported",
      )
      const session = SessionID.make("ses_native_context_failure")
      for (const marker of ["OVERFLOW", "OTHER"]) {
        const offset = rows.length
        const err = yield* llm
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
            agent: { name: "fixture", mode: "primary", permission: [], options: {}, hidden: true },
            system: [],
            messages: [{ role: "user", content: `NATIVE_FAILURE_FIXTURE ${marker}` }],
            retries: 0,
            tools: {},
          })
          .pipe(Stream.runCollect, Effect.flip)
        const parsed = MessageV2.fromError(err, { providerID: id })
        if (!(err instanceof LLMError)) throw new Error("Expected the actual native transport failure")
        expect(err.retryable).toBe(false)
        expect(MessageV2.ContextOverflowError.isInstance(parsed)).toBe(marker === "OVERFLOW")
        if (marker === "OVERFLOW") {
          if (!MessageV2.ContextOverflowError.isInstance(parsed)) throw new Error("Native overflow classification lost")
          expect(parsed.data.responseBody).toContain("context_length_exceeded")
          expect(parsed.data.message).toContain("33000")
        }
        expect(rows.slice(offset)).toHaveLength(1)
        expect(rows.pop()).toMatchObject({ shift: false, truncate: false, options: { num_predict: 1024 } })
      }
    }),
  { config },
  45000,
)
native.instance(
  "actual opted-in openai native LLM streams through the byte bridge with the selected output cap",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const llm = yield* LLM.Service
      const id = ProviderV2.ID.make("openai")
      const model = yield* provider.getModel(id, ModelV2.ID.make("fixture"))
      const selected = yield* provider.getProvider(id)
      expect((yield* RuntimeFlags.Service).experimentalNativeLlm).toBe(true)
      expect(LLMNativeRuntime.status({ model, provider: selected, auth: undefined }).type).toBe("supported")
      gate.resolve()
      const session = SessionID.make("ses_ollama_bridge_fixture")
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
          agent: { name: "fixture", mode: "primary", permission: [], options: {}, hidden: true },
          system: [],
          messages: [{ role: "user", content: "café" }],
          retries: 0,
          tools: {},
        })
        .pipe(Stream.runCollect)
      expect(
        events
          .filter(LLMEvent.is.textDelta)
          .map((event) => event.text)
          .join(""),
      ).toBe("bridge-branch")
      expect(rows.pop()).toMatchObject({ shift: false, truncate: false, options: { num_predict: 1024 } })
    }),
  { config },
  45000,
)
native.instance(
  "genuine native tool continuation maps model reasoning none to think false and preserves call identity and result",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const llm = yield* LLM.Service
      const id = ProviderV2.ID.make("openai")
      const model = yield* provider.getModel(id, ModelV2.ID.make("fixture"))
      expect(model.options.reasoningEffort).toBe("none")
      expect((yield* RuntimeFlags.Service).experimentalNativeLlm).toBe(true)
      expect(LLMNativeRuntime.status({ model, provider: yield* provider.getProvider(id), auth: undefined }).type).toBe(
        "supported",
      )
      const session = SessionID.make("ses_ollama_tool_continuation")
      const calls: unknown[] = []
      const run = (messages: ModelMessage[], choice: "auto" | "required") =>
        llm
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
            agent: { name: "fixture", mode: "primary", permission: [], options: {}, hidden: true },
            system: [],
            messages,
            retries: 0,
            toolChoice: choice,
            tools: {
              metadata: tool({
                description: "Return harmless fixture metadata",
                inputSchema: jsonSchema({
                  type: "object",
                  properties: { tag: { type: "string" } },
                  required: ["tag"],
                  additionalProperties: false,
                }),
                execute: async (input) => {
                  calls.push(input)
                  return { tag: "METADATA_OK" }
                },
              }),
            },
          })
          .pipe(Stream.runCollect)
      const original: ModelMessage = { role: "user", content: "TOOL_CONTINUATION_FIXTURE" }
      const first = yield* run([original], "required")
      const call = first.find(LLMEvent.is.toolCall)
      const result = first.find(LLMEvent.is.toolResult)
      if (!call || !result) throw new Error("Native fixture tool execution missing")
      expect(calls).toEqual([{ tag: "METADATA_OK" }])
      expect(result.result).toEqual({ type: "json", value: { tag: "METADATA_OK" } })
      expect(result.id).toBe(call.id)
      const reasoning = first
        .filter(LLMEvent.is.reasoningDelta)
        .map((event) => event.text)
        .join("")
      expect(reasoning).toBe("plan")
      const second = yield* run(
        [
          original,
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: reasoning },
              { type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.id,
                toolName: call.name,
                output: { type: "json", value: { tag: "METADATA_OK" } },
              },
            ],
          },
        ],
        "auto",
      )
      expect(
        second
          .filter(LLMEvent.is.textDelta)
          .map((event) => event.text)
          .join(""),
      ).toBe("CONTINUATION_OK")
      const row = rows.pop()
      const guidance =
        "For this response, call at least one tool from the supplied tools list. Do not return a text-only answer."
      const messages = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
      )(row?.messages)
      expect(messages.some((message) => message.content.includes(guidance))).toBe(false)
      expect(row).toMatchObject({
        think: false,
        shift: false,
        truncate: false,
        options: { num_predict: 1024 },
        messages: expect.arrayContaining([
          {
            role: "assistant",
            content: "",
            thinking: "plan",
            tool_calls: [{ function: { name: "metadata", arguments: { tag: "METADATA_OK" } } }],
          },
          { role: "tool", content: '{"tag":"METADATA_OK"}', tool_name: "metadata" },
        ]),
      })
      const initial = rows.pop()
      const prefix = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
      )(initial?.messages)
      expect(prefix.filter((message) => message.role === "system")[0].content).toEndWith("\n\n" + guidance)
      expect(prefix.filter((message) => message.content.includes(guidance))).toHaveLength(1)
      expect(initial).toMatchObject({
        think: false,
        shift: false,
        truncate: false,
        tools: [{ type: "function", function: { name: "metadata" } }],
        messages: expect.arrayContaining([{ role: "user", content: "TOOL_CONTINUATION_FIXTURE" }]),
      })
      expect(calls).toHaveLength(1)
    }),
  {
    config: {
      ...config,
      provider: {
        ...config.provider,
        openai: {
          ...config.provider.openai,
          models: { fixture: { ...config.provider.openai.models.fixture, options: { reasoningEffort: "none" } } },
        },
      },
    },
  },
  45000,
)
test("actual Effect native HTTP JSON body arrives as bytes and reaches the bridge unchanged", async () => {
  const selected = localFetch({ localInference: true, localInferenceAPI: "ollama" })
  const seen: boolean[] = []
  const fetcher: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen.push(init?.body instanceof Uint8Array)
      return selected(input, init)
    },
    { preconnect: fetch.preconnect },
  )
  const response = await Effect.runPromise(
    HttpClientRequest.post(`${server.url}v1/chat/completions`).pipe(
      HttpClientRequest.bodyJson({ model: "fixture", messages: [{ role: "user", content: "café" }], max_tokens: 1024 }),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap((res) => res.json),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetcher),
    ),
  )
  expect(seen).toEqual([true])
  expect(response).toMatchObject({ choices: [{ message: { content: "Improved draft" } }] })
  expect(rows.pop()).toMatchObject({ messages: [{ role: "user", content: "café" }], options: { num_predict: 1024 } })
})
afterAll(async () => {
  gate.resolve()
  await server.stop(true)
  await disposeAllInstances()
  if (previous === undefined) delete process.env.KILO_DISABLE_MODELS_FETCH
  if (previous !== undefined) process.env.KILO_DISABLE_MODELS_FETCH = previous
})
it.instance(
  "openai branch and SDK enhancement both use explicit native refusal flags",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const offset = rows.length
      const created = yield* requestInDirectory("/session", instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Bridge" }),
      })
      const session = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(yield* created.json)
      const branch = yield* requestInDirectory(`/session/${session.id}/branch-name`, instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Bridge", providerID: "openai", modelID: "fixture" }),
      }).pipe(Effect.forkChild)
      yield* Effect.promise(() => opened.promise)
      gate.resolve()
      const named = yield* Fiber.join(branch)
      expect(named.status).toBe(200)
      expect(yield* named.json).toEqual({ branch: "bridge-branch" })
      const enhanced = yield* requestInDirectory("/enhance-prompt", instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Draft", model: { providerID: "openai", modelID: "fixture" } }),
      })
      expect(enhanced.status).toBe(200)
      expect(yield* enhanced.json).toEqual({ text: "Improved draft" })
      const sent = rows.slice(offset)
      expect(sent).toHaveLength(2)
      for (const row of sent) expect(row).toMatchObject({ shift: false, truncate: false })
    }),
  { config },
  45_000,
)

const sent: Record<string, unknown>[] = []
const state = { phase: "read", called: false, call: "", file: "", criterion: "verified", mode: "valid" }
const endpoint = Bun.serve({
  port: 0,
  async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/chat")
    const body = await request.json()
    sent.push(body)
    if (state.phase === "complete" && !state.called) {
      const original = body.messages.find(
        (message: { role: string; content: string }) =>
          message.role === "tool" && message.content.includes("GENUINE_READ_EVIDENCE"),
      )
      expect(original).toBeDefined()
      const result = JSON.parse(original.content)
      expect(typeof result.toolCallId).toBe("string")
      expect(result.output).toContain("GENUINE_READ_EVIDENCE")
      state.call = state.mode === "evidence" ? "fabricated-call" : result.toolCallId
    }
    const args =
      state.phase === "read"
        ? { kind: "tool", name: "read", arguments: { filePath: state.file } }
        : {
            kind: "tool",
            name: "update_goal",
            arguments: {
              status: "complete",
              summary: "File verified",
              requirements: [
                {
                  criterionID: state.criterion,
                  requirement: "Read the fixture",
                  passed: true,
                  evidence: [{ callID: state.call, summary: "Read the real fixture" }],
                },
              ],
            },
          }
    const content = JSON.stringify(state.called ? { kind: "text", content: "TURN_DONE" } : args)
    state.called = true
    return new Response(
      [
        { model: body.model, message: { role: "assistant", content }, done: false },
        { model: body.model, done: true, done_reason: "stop", prompt_eval_count: 8, eval_count: 3 },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    )
  },
})
const origin = endpoint.url.origin
process.env.RAYA_ENVELOPE_TEST_ORIGIN = origin
afterAll(async () => {
  await endpoint.stop(true)
  delete process.env.RAYA_ENVELOPE_TEST_ORIGIN
})
const completion = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionPrompt.node,
      SessionProjector.node,
      Storage.node,
      FSUtil.node,
      Provider.node,
      RuntimeFlags.node,
    ]),
    [[RuntimeFlags.node, flags]],
  ),
)
completion.instance(
  "completion envelope traverses real Session tools and preserves saved criterion and evidence authority",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const storage = yield* Storage.Service
      const instance = yield* TestInstance
      const goals = RayaGoal.make({ storage, sessions })
      const file = path.join(instance.directory, "verified.txt")
      yield* Effect.promise(() => writeFile(file, "GENUINE_READ_EVIDENCE", "utf8"))
      state.file = file

      for (const mode of ["valid", "criterion", "evidence"]) {
        const created = yield* sessions.create({ title: `Envelope ${mode}` })
        yield* goals.create(created.id, "Read the fixture", undefined, undefined, undefined, [
          { id: "verified", description: "Read the fixture", verification: "Completed read evidence" },
        ])
        yield* Effect.addFinalizer(() => goals.clear(created.id))
        state.phase = "read"
        state.called = false
        const turn = (text: string) =>
          prompt.prompt({
            sessionID: created.id,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("fixture") },
            agent: "envelope",
            parts: [{ type: "text", text }],
          })
        yield* turn("Read the fixture once")
        const messages = yield* sessions.messages({ sessionID: created.id })
        const read = messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool" && part.tool === "read")
        if (!read || read.type !== "tool" || read.state.status !== "completed")
          throw new Error("Real read did not complete")
        expect(read.state.output).toContain("GENUINE_READ_EVIDENCE")
        state.mode = mode
        state.call = ""
        state.criterion = mode === "criterion" ? "invented" : "verified"
        state.phase = "complete"
        state.called = false
        const offset = sent.length
        yield* turn("Complete using the read evidence")
        expect(state.call).toBe(mode === "evidence" ? "fabricated-call" : read.callID)
        const saved = yield* goals.get(created.id)
        expect(saved?.status).toBe(mode === "valid" ? "complete" : "active")
        const parts = (yield* sessions.messages({ sessionID: created.id })).flatMap((message) => message.parts)
        expect(parts.filter((part) => part.type === "tool").map((part) => part.tool)).toEqual(["read", "update_goal"])
        const update = parts.find((part) => part.type === "tool" && part.tool === "update_goal")
        if (!update || update.type !== "tool") throw new Error("Actual goal dispatch missing")
        expect(update.state.status).toBe("completed")
        if (update.state.status !== "completed") throw new Error("Goal tool did not settle")
        expect(update.state.metadata.status).toBe(mode === "valid" ? "complete" : "active")
        expect(update.state.input).toMatchObject({
          requirements: [{ criterionID: state.criterion, evidence: [{ callID: state.call }] }],
        })
        const outgoing = sent[offset]
        expect(outgoing).toMatchObject({ options: { num_ctx: 32768 } })
        expect(outgoing?.tools).toBeUndefined()
        expect(JSON.stringify(outgoing?.format)).toContain('"enum":["verified"]')
      }
    }),
  {
    config: {
      ...config,
      provider: {
        openai: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `${endpoint.url}v1`,
            localInference: true,
            localInferenceAPI: "ollama",
            localInferenceToolFormat: "completion-envelope-v1",
          },
          models: {
            fixture: {
              name: "Envelope fixture",
              options: { reasoningEffort: "none" },
              limit: { context: 32768, output: 1024 },
            },
          },
        },
      },
      enabled_providers: ["openai"],
      permission: { "*": "deny", read: "allow", create_goal: "allow", get_goal: "allow", update_goal: "allow" },
      agent: {
        envelope: {
          mode: "primary",
          steps: 4,
          permission: { "*": "deny", read: "allow", create_goal: "allow", get_goal: "allow", update_goal: "allow" },
        },
      },
    },
  },
  45000,
)
