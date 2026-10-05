import { afterAll, expect } from "bun:test"
import { Effect, Fiber, Schedule, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "../../../src/provider/provider"
import { LLM } from "../../../src/session/llm"
import { SessionID, MessageID } from "../../../src/session/schema"
import { localFetch, LocalInferenceError, status } from "../../../src/kilocode/provider/local-scheduler"
import { KiloSessionProcessor } from "../../../src/kilocode/session/processor"
import { SessionRetry } from "../../../src/session/retry"
import { MessageV2 } from "../../../src/session/message-v2"
import { isRecord } from "../../../src/util/record"
import { disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const gates = new Map<string, PromiseWithResolvers<void>>()
const starts: string[] = []
const tags: (string | null)[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body: unknown = await request.json()
    if (!isRecord(body) || !Array.isArray(body.messages)) return new Response("Invalid fixture", { status: 400 })
    const message: unknown = body.messages.at(-1)
    if (!isRecord(message) || typeof message.content !== "string")
      return new Response("Invalid fixture message", { status: 400 })
    const label = message.content
    const held = gates.get(label)
    if (!held) return new Response("Missing fixture gate", { status: 400 })
    starts.push(label)
    tags.push(request.headers.get("x-raya-inference-lane"))
    const chunk = (finish: boolean) => ({
      id: "priority-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta: finish ? {} : { content: label }, finish_reason: finish ? "stop" : null }],
    })
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(false))}\n\n`))
          await held.promise
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(true))}\n\ndata: [DONE]\n\n`))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const id = ProviderV2.ID.make("priority-fixture")
const config = {
  formatter: false as const,
  lsp: false as const,
  enabled_providers: [String(id)],
  provider: {
    [id]: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${server.url}v1`, localInference: true },
      models: {
        "deepseek-priority": { name: "DeepSeek fixture", limit: { context: 8192, output: 1024 } },
        "qwen-priority": { name: "Qwen fixture", limit: { context: 8192, output: 1024 } },
      },
    },
  },
}
const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, LLM.node, CrossSpawnSpawner.node, Database.node])),
)

function input(model: Provider.Model, label: string): Parameters<LLM.Interface["stream"]>[0] {
  const session = SessionID.make(`ses_${model.id}_${label}`)
  return {
    sessionID: session,
    model,
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
    messages: [{ role: "user", content: label }],
    retries: 0,
    tools: {},
  }
}

afterAll(async () => {
  for (const held of gates.values()) held.resolve()
  await server.stop(true)
  await disposeAllInstances()
})

for (const model of ["deepseek-priority", "qwen-priority"]) {
  it.instance(
    `${model} classifies persisted Routine requests per stream and prioritizes later chat`,
    () =>
      Effect.gen(function* () {
        starts.length = 0
        tags.length = 0
        const database = yield* Database.Service
        const provider = yield* Provider.Service
        const llm = yield* LLM.Service
        const selected = yield* provider.getModel(id, ModelV2.ID.make(model))
        yield* database.db.run(
          `INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('${model}','C:/fixture',1,1,'[]')`,
        )
        for (const label of ["first", "worker", "chat"]) {
          gates.set(label, Promise.withResolvers<void>())
          yield* database.db.run(
            `INSERT INTO session(id,project_id,metadata,slug,directory,title,version,time_created,time_updated) VALUES ('ses_${model}_${label}','${model}',${label === "worker" ? '\'{"rayaRoutine":{"agentID":"fixture"}}\'' : "NULL"},'fixture','C:/fixture','fixture','1',1,1)`,
          )
        }
        const run = (label: string) => llm.stream(input(selected, label)).pipe(Stream.runCollect, Effect.forkChild)
        const until = (check: () => boolean) =>
          Effect.sync(check).pipe(
            Effect.repeat({ until: Boolean, schedule: Schedule.spaced(5) }),
            Effect.timeout(10_000),
          )
        const first = yield* run("first")
        yield* until(() => starts.length === 1)
        const worker = yield* run("worker")
        yield* until(() => status().queued === 1)
        const chat = yield* run("chat")
        yield* until(() => status().queued === 2)
        expect(starts).toEqual(["first"])
        gates.get("first")!.resolve()
        yield* Fiber.join(first)
        yield* until(() => starts.length === 2)
        expect(starts).toEqual(["first", "chat"])
        gates.get("chat")!.resolve()
        yield* Fiber.join(chat)
        yield* until(() => starts.length === 3)
        expect(starts).toEqual(["first", "chat", "worker"])
        gates.get("worker")!.resolve()
        yield* Fiber.join(worker)
        expect(tags).toEqual([null, null, null])
        expect(status()).toEqual({ active: 0, queued: 0, bytes: 0 })
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const held of gates.values()) held.resolve()
          }),
        ),
      ),
    { config },
    30_000,
  )
}

it.instance(
  "actual native LLM stream retains a full-queue refusal for the session retry policy",
  () =>
    Effect.gen(function* () {
      starts.length = 0
      tags.length = 0
      const provider = yield* Provider.Service
      const llm = yield* LLM.Service
      const selected = yield* provider.getModel(id, ModelV2.ID.make("deepseek-priority"))
      const held = Promise.withResolvers<void>()
      gates.set("first", held)
      const first = yield* llm.stream(input(selected, "first")).pipe(Stream.runCollect, Effect.forkChild)
      yield* Effect.sync(() => starts.length === 1).pipe(
        Effect.repeat({ until: Boolean, schedule: Schedule.spaced(5) }),
        Effect.timeout(10_000),
      )
      const request = localFetch({ localInference: true })
      const abort = new AbortController()
      const waiting = Array.from({ length: 8 }, (_, index) =>
        request(new URL(`filler-${index}`, server.url), {
          signal: abort.signal,
        }).then(
          () => undefined,
          (err: unknown) => err,
        ),
      )
      try {
        expect(status().queued).toBe(8)
        const error = yield* llm.stream(input(selected, "refused")).pipe(Stream.runCollect, Effect.flip)
        expect(error).toBeInstanceOf(LocalInferenceError)
        if (!(error instanceof LocalInferenceError)) throw new Error("Native transport lost local refusal identity")
        expect(error.code).toBe("queue-full")
        const parsed = KiloSessionProcessor.parseError(error, { providerID: id, aborted: false })
        expect(MessageV2.APIError.isInstance(parsed)).toBe(true)
        expect(SessionRetry.retryable(parsed)).toBeUndefined()
        expect(starts).toEqual(["first"])
      } finally {
        abort.abort()
        yield* Effect.promise(() => Promise.all(waiting))
        held.resolve()
        yield* Fiber.join(first)
      }
      expect(status()).toEqual({ active: 0, queued: 0, bytes: 0 })
    }),
  { config },
  30_000,
)
