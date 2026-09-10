import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { Runner } from "@/effect/runner"
import { observe } from "@/kilocode/effect/observation"
import * as Workers from "@/kilocode/session/task-worker"
import { make } from "@/kilocode/voice/openai"
import type { OpenAIBinding, OpenAICall, OpenAICallInput } from "@/kilocode/voice/openai-protocol"
import type { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const secret = "a".repeat(64)
const session = SessionID.make("ses_openai_voice_test")
type Prompt = Parameters<SessionPrompt.Interface["prompt"]>[0]

it.live(
  "abandoning a cancellation waiter does not abandon exact-message cleanup",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const cleanup = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const state = yield* fixture(root, () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release)))),
          ),
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        const waiter = yield* state.voice
          .cancel(state.binding.id, state.input.callID, state.binding.generation, secret, root)
          .pipe(Effect.forkChild)
        yield* Deferred.await(cleanup)
        yield* Fiber.interrupt(waiter)
        yield* Deferred.succeed(release, undefined)
        const next = MessageID.ascending()
        const result = yield* state.runner.ensureRunning(
          Effect.gen(function* () {
            expect(yield* state.workers.bind(session, next)).toBe(true)
            return answer({ sessionID: session, messageID: next, parts: [] })
          }).pipe(Effect.ensuring(state.workers.release)),
        )
        expect(result.info.role === "assistant" && result.info.parentID).toBe(next)
        expect(
          (yield* state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root)).status,
        ).toBe("cancelled")
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

function answer(input: Prompt): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID: input.sessionID,
      parentID: input.messageID!,
      role: "assistant",
      agent: "code",
      mode: "code",
      time: { created: Date.now(), completed: Date.now() },
      path: { cwd: process.cwd(), root: process.cwd() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("test"),
      finish: "stop",
    },
    parts: [
      { id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text: "Verified response" },
    ],
  }
}

const fixture = (root: string, work: SessionPrompt.Interface["prompt"] = (input) => Effect.succeed(answer(input))) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const runner = Runner.make<MessageV2.WithParts>(yield* Scope.Scope, {
      onInterrupt: Effect.die("test runtime cancelled"),
    })
    const workers = yield* Workers.make({
      inspect: () => Effect.succeed(observe(runner)),
      requestCancel: (_, id) => runner.requestCancel(id),
    })
    const calls: Prompt[] = []
    const deps = {
      storage,
      sessions: { get: (id: SessionID) => Effect.succeed({ id, directory: root }) },
      workers,
      prompts: {
        prompt: (input: Prompt) =>
          runner.ensureRunning(
            Effect.gen(function* () {
              calls.push(input)
              if (!input.messageID || !(yield* workers.bind(input.sessionID, input.messageID)))
                return yield* Effect.die("cancelled before startup")
              return yield* work(input)
            }).pipe(Effect.orDie, Effect.ensuring(workers.release)),
          ),
      },
    }
    const voice = yield* make(deps)
    const start = { parentSessionID: session, providerCallID: crypto.randomUUID(), requestID: crypto.randomUUID() }
    const binding = yield* voice.start(start, secret, root)
    const input: typeof OpenAICallInput.Type = {
      generation: binding.generation,
      callID: "call_test",
      function: "raya_work",
      arguments: { request: "Inspect the existing Raya task" },
    }
    return { voice, deps, binding, input, start, calls, workers, runner }
  })

const settled = (read: Effect.Effect<typeof OpenAICall.Type, unknown>) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 200 })) {
      const call = yield* read
      if (call.status !== "accepted" && call.status !== "running") return call
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die("voice receipt did not settle")
  })

it.live(
  "retains one intent before dispatch, deduplicates concurrent calls and attributes the actual message",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const storage = yield* Storage.Service
        const state = yield* fixture(root, (input) =>
          Effect.gen(function* () {
            const keys = yield* storage.list(["raya_openai_voice"])
            const stored = yield* storage.read<{ calls: Record<string, { receipt: typeof OpenAICall.Type }> }>(keys[0])
            expect(Object.values(stored.calls)[0].receipt.status).toBe("running")
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(gate)
            return answer(input)
          }).pipe(Effect.orDie),
        )
        const calls = yield* Effect.all(
          Array.from({ length: 8 }, () => state.voice.submit(state.binding.id, state.input, secret, root)),
          { concurrency: "unbounded" },
        )
        expect(new Set(calls.map((call) => call.messageID)).size).toBe(1)
        yield* Deferred.await(entered)
        expect(state.calls).toHaveLength(1)
        expect(state.calls[0].sessionID).toBe(session)
        expect(state.calls[0].parts).toEqual([{ type: "text", text: state.input.arguments.request }])
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...state.input, arguments: { request: "different" } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...state.input, callID: "other" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* Deferred.succeed(gate, undefined)
        const call = yield* settled(
          state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        )
        expect(call.status).toBe("completed")
        expect(call.result?.text).toBe("Verified response")
        expect(call.messageID).toBe(calls[0].messageID)
        expect((yield* state.voice.submit(state.binding.id, state.input, secret, root)).status).toBe("completed")
        expect(state.calls).toHaveLength(1)
        const stored = yield* state.deps.storage.read(["raya_openai_voice", state.binding.id])
        expect(JSON.stringify(stored)).not.toContain(secret)
        expect(JSON.stringify(stored)).toContain(createHash("sha256").update(secret).digest("hex"))
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "rejects capability, directory, generation and provider binding conflicts without dispatch",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const other = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        expect((yield* state.voice.start(state.start, secret, root)).id).toBe(state.binding.id)
        for (const request of [
          state.voice.submit(state.binding.id, state.input, "b".repeat(64), root).pipe(Effect.asVoid),
          state.voice.submit(state.binding.id, state.input, secret, other).pipe(Effect.asVoid),
          state.voice
            .submit(state.binding.id, { ...state.input, generation: "stale" }, secret, root)
            .pipe(Effect.asVoid),
          state.voice.start({ ...state.start, requestID: "other" }, secret, root).pipe(Effect.asVoid),
        ])
          expect(Exit.isFailure(yield* request.pipe(Effect.exit))).toBe(true)
        expect(state.calls).toHaveLength(0)
        expect((yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)).status).toBe(
          "closed",
        )
        expect(
          Exit.isFailure(yield* state.voice.submit(state.binding.id, state.input, secret, root).pipe(Effect.exit)),
        ).toBe(true)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "cancels the owned message and rejects late results while preserving later typed work",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const state = yield* fixture(root, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        const call = yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        expect(
          (yield* state.voice.cancel(state.binding.id, state.input.callID, state.binding.generation, secret, root))
            .status,
        ).toBe("cancelled")
        const next = MessageID.ascending()
        const typed = yield* state.runner.ensureRunning(
          Effect.gen(function* () {
            expect(yield* state.workers.bind(session, next)).toBe(true)
            yield* state.voice.cancel(state.binding.id, state.input.callID, state.binding.generation, secret, root)
            expect(observe(state.runner).phase).toBe("running")
            return answer({ sessionID: session, messageID: next, parts: [] })
          }).pipe(Effect.orDie, Effect.ensuring(state.workers.release)),
        )
        expect(typed.info.role === "assistant" && typed.info.parentID).toBe(next)
        expect(call.messageID).not.toBe(next)
        expect(
          (yield* state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root)).result,
        ).toBeUndefined()
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "does not attribute another parent turn and fences retained calls after owner restart",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root, (input) =>
          Effect.succeed(answer({ ...input, messageID: MessageID.ascending() })),
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        const call = yield* settled(
          state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        )
        expect(call.status).toBe("unknown")
        expect(call.error?.code).toBe("superseded")
        const next = yield* make(state.deps)
        expect((yield* next.start(state.start, secret, root)).status).toBe("closed")
        expect(
          (yield* next.get(state.binding.id, state.input.callID, state.binding.generation, secret, root)).status,
        ).toBe("unknown")
        expect(Exit.isFailure(yield* next.submit(state.binding.id, state.input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        expect(state.calls).toHaveLength(1)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "closing voice preserves admitted work and retained results, but refuses new calls",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const state = yield* fixture(root, (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return answer(input)
          }),
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        expect((yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)).status).toBe(
          "closed",
        )
        expect(observe(state.runner).phase).toBe("running")
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...state.input, callID: "late" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* Deferred.succeed(release, undefined)
        expect(
          (yield* settled(
            state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
          )).status,
        ).toBe("completed")
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "an earlier owner's pending intent is inspectable as unknown and never readmitted",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const state = yield* fixture(root, (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return answer(input)
          }),
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        const restarted = yield* make(state.deps)
        const call = yield* restarted.get(state.binding.id, state.input.callID, state.binding.generation, secret, root)
        expect(call.status).toBe("unknown")
        expect(call.error?.code).toBe("owner_lost")
        expect(
          Exit.isFailure(yield* restarted.submit(state.binding.id, state.input, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(state.calls).toHaveLength(1)
        yield* Deferred.succeed(release, undefined)
        yield* settled(state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root))
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "lease expiry refuses new admission without cancelling already-running parent work",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const state = yield* fixture(root, (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return answer(input)
          }),
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        yield* state.deps.storage.update<{ binding: typeof OpenAIBinding.Type }>(
          ["raya_openai_voice", state.binding.id],
          (stored) => {
            stored.binding = { ...stored.binding, expiresAt: Date.now() - 1 }
          },
        )
        expect((yield* state.voice.start(state.start, secret, root)).status).toBe("closed")
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...state.input, callID: "expired" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(observe(state.runner).phase).toBe("running")
        yield* Deferred.succeed(release, undefined)
        expect(
          (yield* settled(
            state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
          )).status,
        ).toBe("completed")
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "bounds result text and keeps only exact observed tool identities",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root, (input) => {
          const message = answer(input)
          const text: MessageV2.TextPart = {
            id: PartID.ascending(),
            messageID: message.info.id,
            sessionID: input.sessionID,
            type: "text",
            text: "x".repeat(13000),
          }
          const tools: MessageV2.ToolPart[] = Array.from({ length: 70 }, (_, index) => ({
            id: PartID.ascending(),
            messageID: message.info.id,
            sessionID: input.sessionID,
            type: "tool",
            callID: `tool_${index}`,
            tool: index === 0 ? "x".repeat(129) : `observed_${index}`,
            state: {
              status: "completed",
              input: {},
              output: "tool result",
              title: "actual fixture receipt",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          }))
          return Effect.succeed({ info: message.info, parts: [text, ...tools] })
        })
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        const call = yield* settled(
          state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        )
        expect(call.status).toBe("completed")
        expect(call.result!.text.length).toBeLessThanOrEqual(12000)
        expect(call.result!.text).toContain("Response shortened")
        expect(call.result!.evidence).toHaveLength(64)
        expect(call.result!.evidence[0].tool).toBe("observed_1")
        expect(call.result!.evidence.every((part) => part.messageID === call.result!.assistantMessageID)).toBe(true)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6p8AAAAASUVORK5CYII="

it.live(
  "stages immutable bound images without work and dispatches only their verified bytes",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const input = { generation: state.binding.generation, id: "image-one", mime: "image/png" as const, data: png }
        const uploads = yield* Effect.all(
          [
            state.voice.stage(state.binding.id, input, secret, root),
            state.voice.stage(state.binding.id, input, secret, root),
          ],
          { concurrency: "unbounded" },
        )
        expect(uploads[0]).toEqual(uploads[1])
        expect(uploads[0]).toEqual({
          id: input.id,
          mime: input.mime,
          bytes: Buffer.from(png, "base64").length,
          sha256: createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"),
        })
        expect(state.calls).toEqual([])
        const altered = Buffer.from(png, "base64")
        altered[30] ^= 1
        expect(
          Exit.isFailure(
            yield* state.voice
              .stage(state.binding.id, { ...input, data: altered.toString("base64") }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const request = {
          ...state.input,
          arguments: { request: "Inspect this explicitly attached image", images: [input.id] },
        }
        const accepted = yield* state.voice.submit(state.binding.id, request, secret, root)
        const result = yield* settled(
          state.voice.get(state.binding.id, request.callID, state.binding.generation, secret, root),
        )
        expect(result.status).toBe("completed")
        expect(result.images).toEqual([uploads[0]])
        expect(state.calls[0]?.messageID).toBe(accepted.messageID)
        expect(state.calls[0]?.parts).toEqual([
          { type: "text", text: request.arguments.request },
          { type: "file", mime: "image/png", url: `data:image/png;base64,${png}` },
        ])
        yield* state.voice.submit(state.binding.id, request, secret, root)
        expect(state.calls.length).toBe(1)
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...request, arguments: { ...request.arguments, images: [] } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "image staging enforces format, capacity, owner and selection boundaries with actual storage",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const other = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const input = { generation: state.binding.generation, id: "image-one", mime: "image/png" as const, data: png }
        for (const data of ["", png + "\n", png.replace(/=$/, ""), "!!!!", Buffer.alloc(262145).toString("base64")])
          expect(
            Exit.isFailure(
              yield* state.voice.stage(state.binding.id, { ...input, data }, secret, root).pipe(Effect.exit),
            ),
          ).toBe(true)
        for (const mime of ["image/jpeg", "image/webp"] as const)
          expect(
            Exit.isFailure(
              yield* state.voice.stage(state.binding.id, { ...input, mime }, secret, root).pipe(Effect.exit),
            ),
          ).toBe(true)
        expect(
          Exit.isFailure(yield* state.voice.stage(state.binding.id, input, "b".repeat(64), root).pipe(Effect.exit)),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice
              .stage(state.binding.id, { ...input, generation: "stale" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(Exit.isFailure(yield* state.voice.stage(state.binding.id, input, secret, other).pipe(Effect.exit))).toBe(
          true,
        )
        for (const id of Array.from({ length: 8 }, (_, i) => `image-${i}`))
          yield* state.voice.stage(state.binding.id, { ...input, id }, secret, root)
        expect(Exit.isFailure(yield* state.voice.stage(state.binding.id, input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        yield* state.voice.stage(state.binding.id, { ...input, id: "image-0" }, secret, root)
        expect(state.calls).toEqual([])
        for (const ids of [
          ["missing"],
          ["image-0", "image-0"],
          ["image-0", "image-1", "image-2", "image-3", "image-4"],
        ])
          expect(
            Exit.isFailure(
              yield* state.voice
                .submit(
                  state.binding.id,
                  { ...state.input, arguments: { request: "Check", images: ids } },
                  secret,
                  root,
                )
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        const second = yield* state.voice.start({ ...state.start, providerCallID: crypto.randomUUID() }, secret, root)
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(
                second.id,
                { ...state.input, generation: second.generation, arguments: { request: "Check", images: ["image-0"] } },
                secret,
                root,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const storage = yield* Storage.Service
        const key = ["raya_openai_voice", state.binding.id]
        const retained = yield* storage.read<{ images: Record<string, { data: string }> }>(key)
        retained.images[createHash("sha256").update("image-0").digest("hex")].data = "corrupted"
        yield* storage.replace(key, retained)
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(
                state.binding.id,
                { ...state.input, arguments: { request: "Check", images: ["image-0"] } },
                secret,
                root,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const restarted = yield* make(state.deps)
        expect(Exit.isFailure(yield* restarted.stage(state.binding.id, input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
        expect(Exit.isFailure(yield* state.voice.stage(state.binding.id, input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        expect(state.calls).toEqual([])
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "voice usage receipts are immutable, scoped, retained after closure and never dispatch work",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const receipt = {
          id: "response_1",
          kind: "response" as const,
          model: "gpt-realtime-2.1" as const,
          status: "reported" as const,
          tokens: { input: 12, output: 3, total: 15, cached: 4, inputText: 4, inputAudio: 8 },
        }
        const input = { generation: state.binding.generation, receipt }
        expect(yield* state.voice.usage(state.binding.id, input.generation, secret, root)).toEqual({ receipts: [] })
        expect(yield* state.voice.meter(state.binding.id, input, secret, root)).toEqual(receipt)
        expect(
          yield* state.voice.meter(
            state.binding.id,
            {
              ...input,
              receipt: {
                ...receipt,
                tokens: { total: 15, output: 3, input: 12, inputAudio: 8, inputText: 4, cached: 4 },
              },
            },
            secret,
            root,
          ),
        ).toEqual(receipt)
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(
                state.binding.id,
                { ...input, receipt: { ...receipt, tokens: { input: 13, output: 3, total: 16 } } },
                secret,
                root,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(state.binding.id, { ...input, generation: "stale" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice.usage(state.binding.id, input.generation, "b".repeat(64), root).pipe(Effect.exit),
          ),
        ).toBe(true)
        const missing = {
          id: "transcript_1",
          kind: "transcription" as const,
          model: "gpt-live-transcribe" as const,
          status: "missing" as const,
        }
        yield* state.voice.meter(state.binding.id, { ...input, receipt: missing }, secret, root)
        const duration = {
          id: "duration_1",
          kind: "transcription" as const,
          model: "gpt-live-transcribe" as const,
          status: "reported" as const,
          seconds: 2.75,
        }
        yield* state.voice.meter(state.binding.id, { ...input, receipt: duration }, secret, root)
        expect(state.calls).toEqual([])
        yield* state.voice.close(state.binding.id, input.generation, secret, root)
        expect((yield* state.voice.usage(state.binding.id, input.generation, secret, root)).receipts).toEqual([
          receipt,
          missing,
          duration,
        ])
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(state.binding.id, { ...input, receipt: { ...receipt, id: "later" } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const restarted = yield* make(state.deps)
        expect((yield* restarted.usage(state.binding.id, input.generation, secret, root)).receipts).toHaveLength(3)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "voice usage rejects inconsistent counts and unknown reports cannot masquerade as measured zero",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const receipt = {
          id: "response_1",
          kind: "response" as const,
          model: "gpt-realtime-2.1" as const,
          status: "reported" as const,
          tokens: { input: 5, output: 2, total: 7 },
        }
        const input = { generation: state.binding.generation, receipt }
        for (const tokens of [
          { input: -1, output: 2, total: 1 },
          { input: 5, output: 2, total: 9 },
          { input: 5, output: 2, total: 7, cached: 6 },
          { input: 5, output: 2, total: 7, inputAudio: 6 },
          { input: 5, output: 2, total: 7, outputAudio: 3 },
        ])
          expect(
            Exit.isFailure(
              yield* state.voice
                .meter(state.binding.id, { ...input, receipt: { ...receipt, tokens } }, secret, root)
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(state.binding.id, { ...input, receipt: { ...receipt, status: "missing" } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(
                state.binding.id,
                { ...input, receipt: { ...receipt, model: "gpt-live-transcribe" } },
                secret,
                root,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* state.voice.usage(state.binding.id, input.generation, secret, root)).receipts).toEqual([])
        yield* state.voice.meter(state.binding.id, input, secret, root)
        const storage = yield* Storage.Service
        const key = ["raya_openai_voice", state.binding.id]
        const retained = yield* storage.read<{ usage: Record<string, typeof receipt> }>(key)
        retained.usage.corrupted = receipt
        yield* storage.replace(key, retained)
        expect(
          Exit.isFailure(yield* state.voice.usage(state.binding.id, input.generation, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(Exit.isFailure(yield* state.voice.meter(state.binding.id, input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(state.binding.id, { ...input, receipt: { ...receipt, id: "new" } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* storage.read<typeof retained>(key)).usage).toEqual(retained.usage)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)
