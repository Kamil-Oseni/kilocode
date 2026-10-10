import { expect } from "bun:test"
import path from "node:path"
import { Context, Effect, Exit, Fiber, Layer } from "effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient } from "effect/unstable/http"
import { jsonSchema, tool } from "ai"
import { LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { EffectBridge } from "@/effect/bridge"
import type { Provider } from "@/provider/provider"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import * as Lineage from "@/kilocode/task/effect-lineage"
import * as ToolLineage from "@/kilocode/task/effect-tools"
import { createLocalScheduler } from "@/kilocode/provider/local-scheduler"
import { ollama } from "@/kilocode/provider/ollama-bridge"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const options = { localInference: true, localInferenceAPI: "ollama", localInferenceContext: 4096 }
const init = {
  method: "POST",
  body: JSON.stringify({
    model: "owned-fixture",
    messages: [{ role: "user", content: "Owned request" }],
    stream: false,
    max_tokens: 32,
  }),
}
const identity = () => ({
  id: crypto.randomUUID(),
  agentID: crypto.randomUUID(),
  sessionID: SessionID.make(`ses_${crypto.randomUUID()}`),
})

function original<A, E, R>(
  body: (
    execution: ReturnType<typeof RayaTaskExecution.make>,
    owner: ReturnType<typeof identity>,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    return yield* Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        return yield* body(RayaTaskExecution.make(storage), identity())
      }).pipe(
        Effect.provide(
          Storage.layerWithDatabase(path.join(root, "storage")).pipe(
            Layer.provide(Layer.succeed(Database.Service, database)),
          ),
        ),
      )
    }).pipe(Effect.provide(Database.layerFromPath(path.join(root, "selected.sqlite"))), Effect.scoped)
  })
}

function server(mode?: "tool") {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const posts: string[] = []
      const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
      const native = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          await request.text()
          posts.push(url.pathname)
          if (url.pathname === "/hold")
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  streams.set("hold", controller)
                  controller.enqueue(new TextEncoder().encode("owned"))
                },
                cancel() {
                  streams.delete("hold")
                },
              }),
            )
          expect(url.pathname).toBe("/api/chat")
          if (mode === "tool")
            return new Response(
              [
                {
                  model: "owned-fixture",
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [{ function: { name: "read_owned", arguments: { name: "owned.txt" } } }],
                  },
                  done: false,
                },
                { model: "owned-fixture", done: true, done_reason: "stop", prompt_eval_count: 4, eval_count: 2 },
              ]
                .map((row) => JSON.stringify(row))
                .join("\n") + "\n",
            )
          return Response.json({
            model: "owned-fixture",
            message: { role: "assistant", content: "Owned response" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 4,
            eval_count: 2,
          })
        },
      })
      return {
        posts,
        native,
        end() {
          const stream = streams.get("hold")
          if (!stream) throw new Error("Owned hold stream missing")
          streams.delete("hold")
          stream.close()
        },
      }
    }),
    (owned) => Effect.promise(() => owned.native.stop(true)),
  )
}

function until(check: () => boolean) {
  return Effect.gen(function* () {
    while (!check()) yield* Effect.sleep("5 millis")
  }).pipe(Effect.timeout("5 seconds"))
}

// These tests qualify original execution lineage and stale dispatch refusal only.
// They never seed SQL capabilities or claim native participant/effect admission.
it.live(
  "a genuine original run transfers once into a fresh Effect runtime and performs one actual local POST",
  () =>
    original((execution, owner) =>
      Effect.gen(function* () {
        const owned = yield* server()
        const bridge = ollama(options, globalThis.fetch)
        yield* execution.enter(
          owner,
          Effect.gen(function* () {
            const token = yield* Lineage.capture()
            expect(token).toBeDefined()
            const body = Lineage.promise(async (signal) => {
              const response = await bridge(new URL("/v1/chat/completions", owned.native.url), { ...init, signal })
              return response.json()
            })
            const result = yield* Effect.promise(() =>
              Effect.runPromise(Lineage.transfer(token, owner.sessionID, body)),
            )
            expect(result).toMatchObject({ choices: [{ message: { content: "Owned response" } }] })
            expect(owned.posts).toEqual(["/api/chat"])
            expect(Exit.isFailure(yield* Lineage.transfer(token, owner.sessionID, body).pipe(Effect.exit))).toBe(true)
            expect(owned.posts).toHaveLength(1)
          }),
        )
        yield* execution.finish(owner)
        expect(yield* execution.receipt(owner)).toBeUndefined()
      }),
    ),
  30_000,
)

it.live(
  "copied and foreign-session handoffs cannot dispatch and a genuine token remains usable only by its owner",
  () =>
    original((execution, owner) =>
      Effect.gen(function* () {
        const owned = yield* server()
        const bridge = ollama(options, globalThis.fetch)
        yield* execution.enter(
          owner,
          Effect.gen(function* () {
            const token = yield* Lineage.capture()
            if (!token) throw new Error("Genuine original handoff missing")
            const body = Lineage.promise((signal) =>
              bridge(new URL("/v1/chat/completions", owned.native.url), { ...init, signal }).then((response) =>
                response.text(),
              ),
            )
            expect(
              Exit.isFailure(yield* Lineage.transfer(structuredClone(token), owner.sessionID, body).pipe(Effect.exit)),
            ).toBe(true)
            expect(Exit.isFailure(yield* Lineage.transfer(token, "ses_foreign", body).pipe(Effect.exit))).toBe(true)
            expect(owned.posts).toEqual([])
            yield* Lineage.transfer(token, owner.sessionID, body)
            expect(owned.posts).toEqual(["/api/chat"])
          }),
        )
        yield* execution.finish(owner)
      }),
    ),
  30_000,
)

it.live(
  "a queued genuine run retains its own lineage when a retired prior job releases the transport",
  () =>
    original((execution, owner) =>
      Effect.gen(function* () {
        const owned = yield* server()
        const queue = createLocalScheduler({ active: 1, age: 5_000 })
        const bridge = ollama(options, globalThis.fetch)
        const first = yield* execution.enter(
          owner,
          Lineage.promise(() =>
            queue.fetch(globalThis.fetch, new URL("/hold", owned.native.url), { method: "POST", body: "owned" }),
          ),
        )
        if (!first) throw new Error("Original response missing")
        yield* execution.finish(owner)
        const next = identity()
        const second = yield* execution
          .enter(
            next,
            Lineage.promise(async (signal) => {
              const response = await queue.fetch(bridge, new URL("/v1/chat/completions", owned.native.url), {
                ...init,
                signal,
              })
              return response.json()
            }),
          )
          .pipe(Effect.forkChild)
        yield* until(() => queue.snapshot().queued === 1)
        expect(owned.posts).toEqual(["/hold"])
        owned.end()
        yield* Effect.promise(() => first.text())
        expect(yield* Fiber.join(second)).toMatchObject({ choices: [{ message: { content: "Owned response" } }] })
        expect(owned.posts).toEqual(["/hold", "/api/chat"])
        expect(queue.snapshot()).toEqual({ active: 0, queued: 0, bytes: 0 })
        yield* execution.finish(next)
      }),
    ),
  30_000,
)

it.live(
  "a queued request whose original run has retired refuses before its actual native POST",
  () =>
    original((execution, owner) =>
      Effect.gen(function* () {
        const owned = yield* server()
        const queue = createLocalScheduler({ active: 1, age: 5_000 })
        const bridge = ollama(options, globalThis.fetch)
        const first = yield* Effect.promise(() =>
          queue.fetch(globalThis.fetch, new URL("/hold", owned.native.url), { method: "POST", body: "owned" }),
        )
        const pending: Promise<Exit.Exit<Response, unknown>>[] = []
        yield* execution.enter(
          owner,
          Lineage.promise(async () => {
            // Retain the genuine enqueue promise, then end this original body before dequeue.
            pending.push(
              queue
                .fetch(bridge, new URL("/v1/chat/completions", owned.native.url), init)
                .then(Exit.succeed, Exit.fail),
            )
          }),
        )
        yield* execution.finish(owner)
        expect(queue.snapshot().queued).toBe(1)
        owned.end()
        yield* Effect.promise(() => first.text())
        expect(Exit.isFailure(yield* Effect.promise(() => pending[0]))).toBe(true)
        expect(owned.posts).toEqual(["/hold"])
        expect(queue.snapshot()).toEqual({ active: 0, queued: 0, bytes: 0 })
        expect(yield* execution.receipt(owner)).toBeUndefined()
      }),
    ),
  30_000,
)

it.live(
  "an ordinary request without routine lineage still reaches the real local transport",
  () =>
    Effect.gen(function* () {
      const owned = yield* server()
      const response = yield* Lineage.promise((signal) =>
        ollama(options, globalThis.fetch)(new URL("/v1/chat/completions", owned.native.url), { ...init, signal }),
      )
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        choices: [{ message: { content: "Owned response" } }],
      })
      expect(owned.posts).toEqual(["/api/chat"])
    }),
  30_000,
)

it.live(
  "an ordinary queued request does not borrow the retired original job's lineage",
  () =>
    original((execution, owner) =>
      Effect.gen(function* () {
        const owned = yield* server()
        const queue = createLocalScheduler({ active: 1, age: 5_000 })
        const bridge = ollama(options, globalThis.fetch)
        const first = yield* execution.enter(
          owner,
          Lineage.promise(() =>
            queue.fetch(globalThis.fetch, new URL("/hold", owned.native.url), { method: "POST", body: "owned" }),
          ),
        )
        if (!first) throw new Error("Original response missing")
        yield* execution.finish(owner)
        const second = yield* Lineage.promise(async (signal) => {
          const response = await queue.fetch(bridge, new URL("/v1/chat/completions", owned.native.url), {
            ...init,
            signal,
          })
          return response.json()
        }).pipe(Effect.forkChild)
        yield* until(() => queue.snapshot().queued === 1)
        owned.end()
        yield* Effect.promise(() => first.text())
        expect(yield* Fiber.join(second)).toMatchObject({ choices: [{ message: { content: "Owned response" } }] })
        expect(owned.posts).toEqual(["/hold", "/api/chat"])
        expect(queue.snapshot()).toEqual({ active: 0, queued: 0, bytes: 0 })
      }),
    ),
  30_000,
)

it.live(
  "a genuine Promise-origin callback enters its exact session in a fresh runtime and rejects a foreign session",
  () =>
    original((execution, owner) =>
      Effect.gen(function* () {
        const owned = yield* server()
        const body = Lineage.promise((signal) =>
          ollama(options, globalThis.fetch)(new URL("/v1/chat/completions", owned.native.url), {
            ...init,
            signal,
          }).then((response) => response.text()),
        )
        yield* execution.enter(
          owner,
          Lineage.promise(async () => {
            const foreign = Lineage.callback("ses_foreign", body)
            expect(Exit.isFailure(await Effect.runPromiseExit(foreign))).toBe(true)
            expect(owned.posts).toEqual([])
            await Effect.runPromise(Lineage.callback(owner.sessionID, body))
            expect(owned.posts).toEqual(["/api/chat"])
          }),
        )
        yield* execution.finish(owner)
      }),
    ),
  30_000,
)

it.live(
  "a retained original callback refuses before bridge preparation after its original body retires",
  () =>
    original((execution, owner) =>
      Effect.gen(function* () {
        const owned = yield* server()
        const body = Lineage.promise((signal) =>
          ollama(options, globalThis.fetch)(new URL("/v1/chat/completions", owned.native.url), {
            ...init,
            signal,
          }).then((response) => response.text()),
        )
        const callback = yield* execution.enter(
          owner,
          Lineage.promise(async () => Lineage.callback(owner.sessionID, body)),
        )
        if (!callback) throw new Error("Original callback missing")
        yield* execution.finish(owner)
        expect(Exit.isFailure(yield* Effect.promise(() => Effect.runPromiseExit(callback)))).toBe(true)
        expect(owned.posts).toEqual([])
        expect(yield* execution.receipt(owner)).toBeUndefined()
      }),
    ),
  30_000,
)

it.live(
  "actual EffectBridge tool callbacks preserve their original owner and refuse retired or missing routine ownership",
  () =>
    original((execution, owner) =>
      Effect.gen(function* () {
        const owned = yield* server()
        const body = Lineage.promise((signal) =>
          ollama(options, globalThis.fetch)(new URL("/v1/chat/completions", owned.native.url), {
            ...init,
            signal,
          }).then((response) => response.text()),
        )
        const retained = yield* execution.enter(
          owner,
          Effect.gen(function* () {
            const base = yield* EffectBridge.make()
            const bound = yield* ToolLineage.bridge(base, owner.sessionID, true)
            yield* Effect.promise(() => bound.promise(body))
            expect(owned.posts).toEqual(["/api/chat"])
            return bound
          }),
        )
        if (!retained) throw new Error("Original tool bridge missing")
        yield* execution.finish(owner)
        expect(Exit.isFailure(yield* Effect.promise(() => retained.promise(body)).pipe(Effect.exit))).toBe(true)
        expect(owned.posts).toHaveLength(1)
        const base = yield* EffectBridge.make()
        expect(Exit.isFailure(yield* ToolLineage.bridge(base, owner.sessionID, true).pipe(Effect.exit))).toBe(true)
        const ordinary = yield* ToolLineage.bridge(base, owner.sessionID, false)
        yield* Effect.promise(() => ordinary.promise(body))
        expect(owned.posts).toEqual(["/api/chat", "/api/chat"])
      }),
    ),
  30_000,
)

it.live(
  "interrupting the actual queued original joins it and cannot reuse its retained request runner",
  () =>
    original((execution, owner) =>
      Effect.gen(function* () {
        const owned = yield* server()
        const queue = createLocalScheduler({ active: 1, age: 5_000 })
        const bridge = ollama(options, globalThis.fetch)
        const first = yield* Effect.promise(() =>
          queue.fetch(globalThis.fetch, new URL("/hold", owned.native.url), { method: "POST", body: "owned" }),
        )
        const runners: Lineage.Runner[] = []
        const child = yield* execution
          .enter(
            owner,
            Lineage.promise(async (signal) => {
              const runner = Lineage.runner()
              if (!runner) throw new Error("Original request runner missing")
              runners.push(runner)
              const response = await queue.fetch(bridge, new URL("/v1/chat/completions", owned.native.url), {
                ...init,
                signal,
              })
              return response.text()
            }),
          )
          .pipe(Effect.forkChild)
        yield* until(() => queue.snapshot().queued === 1)
        yield* Fiber.interrupt(child)
        expect(Exit.isFailure(yield* Fiber.await(child))).toBe(true)
        expect(queue.snapshot().queued).toBe(0)
        expect(
          Exit.isFailure(
            yield* Effect.tryPromise(() =>
              Lineage.run(runners[0], () => bridge(new URL("/v1/chat/completions", owned.native.url), init)),
            ).pipe(Effect.exit),
          ),
        ).toBe(true)
        owned.end()
        yield* Effect.promise(() => first.text())
        expect(owned.posts).toEqual(["/hold"])
        expect(queue.snapshot()).toEqual({ active: 0, queued: 0, bytes: 0 })
        // Original interruption leaves its authentic active receipt for recovery;
        // this test neither deletes it nor claims SQL admission/debt settlement.
        expect((yield* execution.receipt(owner))?.state).toBe("active")
      }),
    ),
  30_000,
)

it.live(
  "the real native model stream dispatches its tool through the original Routine EffectBridge and refuses after retirement",
  () =>
    original((execution, owner) =>
      Effect.gen(function* () {
        const owned = yield* server("tool")
        const fs = yield* FSUtil.Service
        const root = yield* tmpdirScoped()
        const file = path.join(root, "owned.txt")
        yield* fs.writeFileString(file, "Actual owned bytes café 日本語")
        const client = yield* LLMClient.Service
        const id = ProviderV2.ID.make("openai")
        const model: Provider.Model = {
          id: ModelV2.ID.make("owned-fixture"),
          providerID: id,
          api: { id: "owned-fixture", url: new URL("/v1", owned.native.url).href, npm: "@ai-sdk/openai-compatible" },
          name: "Owned fixture",
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 4096, input: 4096, output: 32 },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-01-01",
        }
        const provider: Provider.Info = {
          id,
          name: "Owned loopback",
          source: "config",
          env: [],
          models: {},
          options: { ...options, baseURL: model.api.url },
        }
        const calls: { id: string; name: string }[] = []
        const retained = yield* execution.enter(
          owner,
          Effect.gen(function* () {
            const base = yield* EffectBridge.make()
            const bound = yield* ToolLineage.bridge(base, owner.sessionID, true)
            const runner = yield* Lineage.bind()
            expect(runner).toBeDefined()
            const native = LLMNativeRuntime.stream({
              model,
              provider,
              auth: undefined,
              llmClient: client,
              sessionID: owner.sessionID,
              runner,
              messages: [{ role: "user", content: "Read owned.txt using read_owned" }],
              headers: {},
              abort: new AbortController().signal,
              maxOutputTokens: 32,
              tools: {
                read_owned: tool({
                  description: "Read the owned test file",
                  inputSchema: jsonSchema<{ name: string }>({
                    type: "object",
                    properties: { name: { type: "string", enum: ["owned.txt"] } },
                    required: ["name"],
                    additionalProperties: false,
                  }),
                  execute: (input, opts) =>
                    bound.promise(
                      Effect.gen(function* () {
                        yield* Lineage.check()
                        expect(input.name).toBe("owned.txt")
                        calls.push({ id: opts.toolCallId, name: input.name })
                        return { output: yield* fs.readFileString(file) }
                      }),
                    ),
                }),
              },
            })
            expect(native.type).toBe("supported")
            if (native.type !== "supported") throw new Error("Owned native adapter unsupported")
            const events = yield* native.stream.pipe(Stream.runCollect)
            const dispatched = events.filter(LLMEvent.is.toolCall)
            const results = events.filter(LLMEvent.is.toolResult)
            expect(dispatched).toHaveLength(1)
            expect(results).toHaveLength(1)
            expect(calls).toEqual([{ id: dispatched[0].id, name: "owned.txt" }])
            expect(JSON.stringify(results)).toContain("Actual owned bytes café 日本語")
            expect(owned.posts).toEqual(["/api/chat"])
            return native
          }),
        )
        if (!retained) throw new Error("Original native stream missing")
        yield* execution.finish(owner)
        expect(Exit.isFailure(yield* retained.stream.pipe(Stream.runCollect, Effect.exit))).toBe(true)
        expect(owned.posts).toEqual(["/api/chat"])
        expect(calls).toHaveLength(1)
        expect(yield* execution.receipt(owner)).toBeUndefined()
      }),
    ).pipe(
      Effect.provide(
        LLMClient.layer.pipe(
          Layer.provide(
            Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)), WebSocketExecutor.layer),
          ),
        ),
      ),
    ),
  30_000,
)

it.live(
  "same-key structural frames, copied private tokens, and frozen-token mutation cannot mint or revive original dispatch",
  () =>
    original((execution, owner) =>
      Effect.gen(function* () {
        const owned = yield* server()
        const reference = Context.Reference<object | undefined>("@raya/ExecutionLineage", {
          defaultValue: () => undefined,
        })
        const body = Lineage.promise((signal) =>
          ollama(options, globalThis.fetch)(new URL("/v1/chat/completions", owned.native.url), {
            ...init,
            signal,
          }).then((response) => response.text()),
        )
        const fake = {
          alive: true,
          fiber: {},
          root: {
            alive: true,
            original: { alive: () => true, runID: owner.id, agentID: owner.agentID, sessionID: owner.sessionID },
          },
        }
        expect(Exit.isFailure(yield* body.pipe(Effect.provideService(reference, fake), Effect.exit))).toBe(true)
        const token = yield* execution.enter(
          owner,
          Effect.gen(function* () {
            const frame = yield* Effect.withFiber((fiber) =>
              Effect.sync(() => Context.getReferenceUnsafe(fiber.context, reference)),
            )
            if (!frame) throw new Error("Genuine private frame missing")
            expect(Object.isFrozen(frame)).toBe(true)
            expect(Reflect.set(frame, "alive", true)).toBe(false)
            expect(Reflect.defineProperty(frame, "root", { value: fake.root })).toBe(false)
            for (const copy of [structuredClone(frame), { ...frame }]) {
              expect(Exit.isFailure(yield* body.pipe(Effect.provideService(reference, copy), Effect.exit))).toBe(true)
              expect(
                Exit.isFailure(yield* Lineage.capture().pipe(Effect.provideService(reference, copy), Effect.exit)),
              ).toBe(true)
            }
            yield* Lineage.check()
            expect(owned.posts).toEqual([])
            return frame
          }),
        )
        if (!token) throw new Error("Original private token missing")
        yield* execution.finish(owner)
        expect(Reflect.set(token, "alive", true)).toBe(false)
        expect(Exit.isFailure(yield* body.pipe(Effect.provideService(reference, token), Effect.exit))).toBe(true)
        expect(owned.posts).toEqual([])
        expect(yield* execution.receipt(owner)).toBeUndefined()
      }),
    ),
  30_000,
)
