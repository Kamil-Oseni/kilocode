import { expect } from "bun:test"
import { Effect, Fiber, Queue, Exit, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageID, PartID } from "@/session/schema"
import { ChiefRouteTool } from "@/kilocode/tool/chief-route"
import { RayaChief } from "@/kilocode/chief"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      Database.node,
      SessionProjector.node,
      Agent.node,
      Config.node,
      Provider.node,
      Question.node,
      Session.node,
      EventV2Bridge.node,
      Truncate.node,
    ]),
  ),
)
const cfg = {
  snapshot: false,
  plugin: [],
  mcp: {},
  enabled_providers: ["local"],
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      env: [],
      options: { baseURL: "http://127.0.0.1:11434/v1" },
      models: { fixture: { name: "fixture" } },
    },
  },
  agent: { generalist: { model: "local/fixture" }, designer: { model: "local/fixture" } },
} satisfies Partial<Config.Info>

const dispatch = Effect.fn(function* (dir: string, request: string, prior?: Session.Info) {
  const sessions = yield* Session.Service
  const chat = prior ?? (yield* sessions.create())
  yield* sessions.setMetadata({
    sessionID: chat.id,
    metadata: { [RayaChief.requestKey]: request, [RayaChief.phaseKey]: "route" },
  })
  const model = { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") }
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "user",
    agent: "auto",
    model,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: user.id,
    type: "text",
    text: request,
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    parentID: user.id,
    role: "assistant",
    agent: "auto",
    mode: "auto",
    cost: 0,
    path: { cwd: dir, root: dir },
    providerID: model.providerID,
    modelID: model.modelID,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  })
  const abort = new AbortController()
  return {
    chat,
    user,
    abort,
    ctx: {
      sessionID: chat.id,
      messageID: assistant.id,
      agent: "auto",
      abort: abort.signal,
      messages: yield* sessions.messages({ sessionID: chat.id }),
      metadata: () => Effect.void,
      ask: () => Effect.void,
    },
  }
})
const asked = Effect.fn(function* () {
  const events = yield* EventV2Bridge.Service
  const queue = yield* Queue.unbounded<Question.Request>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type)
      Queue.offerUnsafe(queue, Schema.decodeUnknownSync(Question.Request)(event.data))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  return queue
})
const ambiguous = "Help me decide what to do with this project"

it.live(
  "concurrent real router callbacks commit one decision across tool initializations",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const input = yield* dispatch(dir, "Read the fixture contents and report exact bytes.")
          const definition = yield* ChiefRouteTool
          const first = yield* definition.init()
          const second = yield* definition.init()
          const outputs = yield* Effect.all(
            [
              first.execute({ objective: "ignored rewrite" }, input.ctx),
              second.execute({ objective: "other rewrite" }, input.ctx),
            ],
            { concurrency: "unbounded" },
          )
          expect(outputs.filter((x) => x.title === "Auto already routed")).toHaveLength(1)
          const saved = yield* sessions.get(input.chat.id)
          expect(RayaChief.history(saved.metadata)).toHaveLength(1)
          expect(outputs[0].metadata.decision).toEqual(outputs[1].metadata.decision)
          expect(RayaChief.phase(saved.metadata)).toBe("task")
        }),
      { config: cfg },
    ),
  { timeout: 30000 },
)

it.live(
  "separate sessions do not share the held routing permit",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const questions = yield* Question.Service
          const queue = yield* asked()
          const definition = yield* ChiefRouteTool
          const tool = yield* definition.init()
          const one = yield* dispatch(dir, ambiguous)
          const two = yield* dispatch(dir, ambiguous)
          const first = yield* tool.execute({ objective: ambiguous }, one.ctx).pipe(Effect.forkChild)
          const event = yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"))
          const second = yield* tool.execute({ objective: ambiguous }, two.ctx).pipe(Effect.forkChild)
          const other = yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"))
          expect(event.sessionID).not.toBe(other.sessionID)
          yield* questions.reply({ requestID: event.id, answers: [["designer"]] })
          yield* questions.reply({ requestID: other.id, answers: [["designer"]] })
          expect((yield* Fiber.join(first)).metadata.decision?.agent).toBe("designer")
          expect((yield* Fiber.join(second)).metadata.decision?.agent).toBe("designer")
        }),
      { config: cfg },
    ),
  { timeout: 30000 },
)

it.live(
  "cancelled and rejected real question owners release routing without a decision",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const questions = yield* Question.Service
          const queue = yield* asked()
          const tool = yield* (yield* ChiefRouteTool).init()
          const input = yield* dispatch(dir, ambiguous)
          const first = yield* tool.execute({ objective: ambiguous }, input.ctx).pipe(Effect.forkChild)
          yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"))
          input.abort.abort()
          expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)
          expect(RayaChief.history((yield* sessions.get(input.chat.id)).metadata)).toHaveLength(0)
          const ctx = { ...input.ctx, abort: new AbortController().signal }
          const second = yield* tool.execute({ objective: ambiguous }, ctx).pipe(Effect.forkChild)
          const next = yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"))
          yield* questions.reject(next.id)
          expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true)
          expect(RayaChief.phase((yield* sessions.get(input.chat.id)).metadata)).toBe("route")
          const third = yield* tool.execute({ objective: ambiguous }, ctx).pipe(Effect.forkChild)
          const final = yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"))
          yield* questions.reply({ requestID: final.id, answers: [["designer"]] })
          expect((yield* Fiber.join(third)).metadata.decision?.agent).toBe("designer")
          expect(RayaChief.history((yield* sessions.get(input.chat.id)).metadata)).toHaveLength(1)
        }),
      { config: cfg },
    ),
  { timeout: 30000 },
)

it.live(
  "new user dispatch supersedes a held older route without stale metadata commit",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const questions = yield* Question.Service
          const queue = yield* asked()
          const tool = yield* (yield* ChiefRouteTool).init()
          const old = yield* dispatch(dir, ambiguous)
          const first = yield* tool.execute({ objective: ambiguous }, old.ctx).pipe(Effect.forkChild)
          const event = yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"))
          const fresh = yield* dispatch(dir, "Read the fixture contents and report exact bytes.", old.chat)
          const result = yield* tool.execute({ objective: "ignored" }, fresh.ctx)
          expect(result.metadata.decision?.request).toBe("Read the fixture contents and report exact bytes.")
          yield* questions.reply({ requestID: event.id, answers: [["designer"]] })
          expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)
          const saved = yield* sessions.get(old.chat.id)
          expect(RayaChief.history(saved.metadata)).toHaveLength(1)
          expect(RayaChief.history(saved.metadata)[0]?.request).toBe(result.metadata.decision?.request)
        }),
      { config: cfg },
    ),
  { timeout: 30000 },
)
