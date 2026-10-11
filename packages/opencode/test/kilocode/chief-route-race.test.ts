import { expect } from "bun:test"
import path from "node:path"
import { Cause, Effect, Fiber, Queue, Exit, Schema, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageID, PartID } from "@/session/schema"
import { ChiefRouteTool } from "@/kilocode/tool/chief-route"
import type { DefWithoutID } from "@/tool/tool"
import { RayaChief } from "@/kilocode/chief"
import { RayaGoal } from "@/kilocode/goal"
import { goalTools } from "@/kilocode/tool/goal"
import { Storage } from "@/storage/storage"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const graph = LayerNode.group([
  CrossSpawnSpawner.node,
  Database.node,
  SessionProjector.node,
  Agent.node,
  Config.node,
  Provider.node,
  Question.node,
  Permission.node,
  Session.node,
  EventV2Bridge.node,
  Truncate.node,
  Storage.node,
  FSUtil.node,
  Git.node,
])
const it = testEffect(LayerNode.compile(graph))
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

it.live("a genuinely routed Auto turn can create its original persistent goal", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const objective = "Write one text file and read it back."
        const input = yield* dispatch(dir, objective)
        const goals = RayaGoal.make({ storage, sessions })
        const catalog = { create_goal: goalTools(goals, sessions).create }
        expect(RayaChief.tools(catalog, (yield* sessions.get(input.chat.id)).metadata)).toEqual({})
        const route = yield* (yield* ChiefRouteTool).init()
        const decision = yield* route.execute({ result: "narrative", access: "edit", objective }, input.ctx)
        expect(decision.metadata.decision?.direct).not.toBe(true)
        const saved = yield* sessions.get(input.chat.id)
        expect(RayaChief.phase(saved.metadata)).toBe("task")
        const admitted = RayaChief.tools(catalog, saved.metadata)
        expect(admitted.create_goal).toBe(catalog.create_goal)
        const tool = yield* (yield* admitted.create_goal).init()
        const result = yield* tool.execute({ objective }, input.ctx)
        expect(result.metadata.status).toBe("active")
        const goal = yield* goals.get(input.chat.id)
        expect(goal?.objective).toBe(objective)
        expect(goal?.startMessageID).toBe(input.ctx.messageID)
        expect(goal?.status).toBe("active")
        expect(yield* sessions.children(input.chat.id)).toHaveLength(0)
        const refused = yield* tool.execute({ objective: "Replace the original goal" }, input.ctx)
        expect(refused.metadata.status).toBeUndefined()
        expect(yield* goals.get(input.chat.id)).toEqual(goal)
        const current = yield* sessions.get(input.chat.id)
        expect(current.metadata?.["raya.goal.open"]).toBe(true)
        expect(RayaChief.tools(catalog, current.metadata)).toEqual({})
      }).pipe(
        Effect.provide(
          Layer.fresh(
            LayerNode.compile(graph, [
              [Database.node, Database.layerFromPath(path.join(dir, "goal.sqlite"))],
              [
                Storage.node,
                LayerNode.make({
                  service: Storage.Service,
                  layer: Storage.layerWithDatabase(path.join(dir, "goal-storage")),
                  deps: [FSUtil.node, Git.node, Database.node],
                }),
              ],
            ]),
          ),
        ),
      ),
    { config: cfg },
  ),
)

it.live("a prompted greeting cannot persist a denied delegated specialist", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const questions = yield* Question.Service
        const queue = yield* asked()
        const request = "Explain the term operations"
        const input = yield* dispatch(dir, request)
        const agents = yield* Agent.Service
        const initial = RayaChief.route({
          request,
          access: "read",
          agents: (yield* agents.list()).filter((item) => ["generalist", "designer"].includes(item.name)),
        })
        expect(RayaChief.direct(request)).toBe(true)
        expect(initial.candidates.some((item) => item.score > 0)).toBe(true)
        expect(initial.candidates).toHaveLength(2)
        expect(RayaChief.needsPrompt(initial, 1, request)).toBe(true)
        const tool = yield* (yield* ChiefRouteTool).init()
        const pending = yield* tool
          .execute({ result: "narrative", objective: request, access: "read" }, input.ctx)
          .pipe(Effect.forkChild)
        const event = yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"))
        yield* questions.reply({ requestID: event.id, answers: [["generalist"]] })
        const result = yield* Fiber.await(pending)
        expect(Exit.isFailure(result)).toBe(true)
        const saved = yield* sessions.get(input.chat.id)
        expect(RayaChief.history(saved.metadata)).toHaveLength(0)
        expect(RayaChief.phase(saved.metadata)).toBe("route")
        expect(yield* sessions.children(input.chat.id)).toHaveLength(0)
      }),
    {
      config: {
        ...cfg,
        permission: { task: { "*": "deny", designer: "allow" } },
        raya_routing: { confidence_threshold: 1 },
      },
    },
  ),
)

for (const mode of ["deny", "general"] as const)
  it.live(`a verified greeting remains direct with ${mode} Task permissions`, () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const input = yield* dispatch(dir, "Hello.")
          const tool = yield* (yield* ChiefRouteTool).init()
          const result = yield* tool.execute({ result: "narrative", objective: "Hello.", access: "read" }, input.ctx)
          expect(result.metadata.decision?.direct).toBe(true)
          expect(result.metadata.decision?.agent).toBe("generalist")
          expect(result.metadata.decision?.userID).toBe(input.user.id)
          expect(result.metadata.decision?.request).toBe("Hello.")
          expect(RayaChief.phase((yield* sessions.get(input.chat.id)).metadata)).toBe("done")
          expect(yield* sessions.children(input.chat.id)).toHaveLength(0)
        }),
      { config: { ...cfg, permission: { task: mode === "deny" ? "deny" : { "*": "deny", general: "allow" } } } },
    ),
  )

for (const mode of ["allowed", "caller", "parent"] as const)
  it.live(`initial Chief routing respects ${mode} Task permissions`, () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const agents = yield* Agent.Service
          const request = "Write one text file and read it back."
          const input = yield* dispatch(dir, request)
          if (mode === "parent")
            yield* sessions.setPermission({
              sessionID: input.chat.id,
              permission: Permission.fromConfig({ task: "deny" }),
            })
          const caller = yield* agents.get("auto")
          expect(caller).toBeDefined()
          expect(caller && Permission.evaluate("task", "general", caller.permission).action).toBe(
            mode === "caller" ? "deny" : "allow",
          )
          const tool = yield* (yield* ChiefRouteTool).init()
          const result = yield* tool
            .execute({ result: "narrative", objective: request, access: "edit" }, input.ctx)
            .pipe(Effect.exit)
          const saved = yield* sessions.get(input.chat.id)
          if (mode !== "allowed") {
            expect(Exit.isFailure(result)).toBe(true)
            expect(RayaChief.history(saved.metadata)).toHaveLength(0)
            expect(RayaChief.phase(saved.metadata)).toBe("route")
            return
          }
          expect(Exit.isSuccess(result)).toBe(true)
          const routed = yield* result
          expect(routed.metadata.decision?.agent).toBe("general")
          expect(routed.metadata.decision?.access).toBe("edit")
          expect(routed.metadata.decision?.request).toBe(request)
          expect(routed.metadata.decision?.candidates.every((item) => item.agent === "general")).toBe(true)
          expect(RayaChief.history(saved.metadata)).toHaveLength(1)
          expect(yield* sessions.children(input.chat.id)).toHaveLength(0)
        }),
      {
        config: {
          ...cfg,
          permission: { task: mode === "caller" ? "deny" : { "*": "deny", general: "allow" } },
        },
      },
    ),
  )

it.live("a real direct greeting decision releases text continuation without releasing required acquisition", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const request =
          "Reply with one short greeting. This is a temporary conversation check; do not save it as a preference or perform any actions."
        const input = yield* dispatch(dir, request)
        const tool = yield* (yield* ChiefRouteTool).init()
        const result = yield* tool.execute(
          { result: "narrative", objective: "model rewrite", access: "read" },
          input.ctx,
        )
        expect(result.metadata.decision?.direct).toBe(true)
        expect(result.metadata.decision?.request).toBe(request)
        const saved = yield* sessions.get(input.chat.id)
        expect(RayaChief.phase(saved.metadata)).toBe("done")
        expect(yield* sessions.children(input.chat.id)).toHaveLength(0)
        yield* Effect.tryPromise(async () => {
          const requests: Record<string, unknown>[] = []
          const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (incoming) => {
              requests.push(await incoming.json())
              return Response.json({
                model: "fixture",
                message: { role: "assistant", content: "Hello there." },
                done: true,
                done_reason: "stop",
              })
            },
          })
          try {
            const send = ollama({ localInference: true, localInferenceAPI: "ollama" }, globalThis.fetch)
            const body = {
              model: "fixture",
              messages: [{ role: "user", content: request }],
              tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
            }
            const refused = await send(`${server.url}v1/chat/completions`, {
              method: "POST",
              body: JSON.stringify({ ...body, tool_choice: "required" }),
            }).then(
              () => undefined,
              (err: unknown) => err,
            )
            expect(refused).toBeInstanceOf(OllamaBridgeError)
            expect(refused instanceof OllamaBridgeError && refused.diagnostic).toMatchObject({
              reason: "required-acquisition",
              refusal: "tool-missing",
            })
            const response = await send(`${server.url}v1/chat/completions`, {
              method: "POST",
              body: JSON.stringify({
                ...body,
                tool_choice: RayaChief.phase(saved.metadata) === "done" ? "none" : "required",
              }),
            })
            expect(await response.text()).toContain("Hello there.")
            expect(requests).toHaveLength(2)
            expect(JSON.stringify(requests[0].messages)).toContain("call at least one tool")
            expect(JSON.stringify(requests[1].messages)).not.toContain("call at least one tool")
          } finally {
            await server.stop()
          }
        })
      }),
    { config: cfg },
  ),
)

for (const mode of ["request", "goal", "edit"] as const)
  it.live(`direct greetings retain ${mode} binding`, () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const tool = yield* (yield* ChiefRouteTool).init()
          const input = yield* dispatch(dir, mode === "request" ? "Hello. Read my file." : "Hello.")
          yield* sessions.setMetadata({
            sessionID: input.chat.id,
            metadata: {
              [RayaChief.requestKey]: "Hello.",
              [RayaChief.phaseKey]: "route",
              ...(mode === "goal" ? { "raya.goal.open": true } : {}),
            },
          })
          const result = yield* tool.execute(
            { result: "narrative", objective: "Hello.", access: mode === "edit" ? "edit" : "read" },
            input.ctx,
          )
          expect(result.metadata.decision?.direct).not.toBe(true)
          expect(RayaChief.phase((yield* sessions.get(input.chat.id)).metadata)).toBe("task")
        }),
      { config: cfg },
    ),
  )

for (const mode of ["text", "goal"] as const)
  it.live(`a direct greeting refuses commit-time ${mode} drift`, () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const input = yield* dispatch(dir, "Hello.")
          let reads = 0
          // Delegate original storage reads; mutate actual persisted state at the
          // second awaited lookup, after direct classification and before commit.
          const routed = {
            ...sessions,
            findMessage: (...args: Parameters<typeof sessions.findMessage>) =>
              Effect.gen(function* () {
                const found = yield* sessions.findMessage(...args)
                if (++reads !== 2) return found
                if (mode === "goal") {
                  const current = yield* sessions.get(input.chat.id)
                  yield* sessions.setMetadata({
                    sessionID: input.chat.id,
                    metadata: { ...current.metadata, "raya.goal.open": true },
                  })
                  return found
                }
                const original = (yield* sessions.messages({ sessionID: input.chat.id })).find(
                  (item) => item.info.id === input.user.id,
                )
                const part = original?.parts.find((item) => item.type === "text")
                if (!part || part.type !== "text") throw new Error("Original user text required")
                yield* sessions.updatePart({ ...part, text: "Hello. Read my file." })
                return found
              }),
          }
          const definition = yield* ChiefRouteTool.pipe(Effect.provideService(Session.Service, routed))
          const tool = yield* definition.init()
          const result = yield* tool
            .execute({ result: "narrative", objective: "Hello.", access: "read" }, input.ctx)
            .pipe(Effect.exit)
          expect(reads).toBe(2)
          const saved = yield* sessions.get(input.chat.id)
          if (mode === "goal") expect(saved.metadata?.["raya.goal.open"]).toBe(true)
          if (mode === "text") {
            const original = (yield* sessions.messages({ sessionID: input.chat.id })).find(
              (item) => item.info.id === input.user.id,
            )
            expect(RayaChief.requestText(original?.parts ?? [])).toBe("Hello. Read my file.")
          }
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result))
            expect(String(Cause.squash(result.cause))).toContain("Auto direct request changed")
          expect(RayaChief.phase(saved.metadata)).toBe("route")
          expect(RayaChief.history(saved.metadata)).toHaveLength(0)
          expect(yield* sessions.children(input.chat.id)).toHaveLength(0)
        }),
      { config: cfg },
    ),
  )

it.live("missing work class refuses before routing while explicit read preserves direct conversation", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const request = "What does idempotency mean?"
        const input = yield* dispatch(dir, request)
        const tool = yield* (yield* ChiefRouteTool).init()
        const boundary: DefWithoutID = tool
        expect(
          Exit.isFailure(yield* Effect.exit(boundary.execute({ result: "narrative", objective: request }, input.ctx))),
        ).toBe(true)
        expect(RayaChief.history((yield* sessions.get(input.chat.id)).metadata)).toHaveLength(0)
        const result = yield* tool.execute({ result: "narrative", objective: request, access: "read" }, input.ctx)
        expect(result.metadata.decision?.direct).toBe(true)
        expect(yield* sessions.children(input.chat.id)).toHaveLength(0)
      }),
    { config: cfg },
  ),
)

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
              first.execute({ result: "narrative", objective: "ignored rewrite", access: "read" }, input.ctx),
              second.execute({ result: "narrative", objective: "other rewrite", access: "read" }, input.ctx),
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
          const first = yield* tool
            .execute({ result: "narrative", objective: ambiguous, access: "read" }, one.ctx)
            .pipe(Effect.forkChild)
          const event = yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"))
          const second = yield* tool
            .execute({ result: "narrative", objective: ambiguous, access: "read" }, two.ctx)
            .pipe(Effect.forkChild)
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
          const first = yield* tool
            .execute({ result: "narrative", objective: ambiguous, access: "read" }, input.ctx)
            .pipe(Effect.forkChild)
          yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"))
          input.abort.abort()
          expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)
          expect(RayaChief.history((yield* sessions.get(input.chat.id)).metadata)).toHaveLength(0)
          const ctx = { ...input.ctx, abort: new AbortController().signal }
          const second = yield* tool
            .execute({ result: "narrative", objective: ambiguous, access: "read" }, ctx)
            .pipe(Effect.forkChild)
          const next = yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"))
          yield* questions.reject(next.id)
          expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true)
          expect(RayaChief.phase((yield* sessions.get(input.chat.id)).metadata)).toBe("route")
          const third = yield* tool
            .execute({ result: "narrative", objective: ambiguous, access: "read" }, ctx)
            .pipe(Effect.forkChild)
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
          const first = yield* tool
            .execute({ result: "narrative", objective: ambiguous, access: "read" }, old.ctx)
            .pipe(Effect.forkChild)
          const event = yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"))
          const fresh = yield* dispatch(dir, "Read the fixture contents and report exact bytes.", old.chat)
          const result = yield* tool.execute({ result: "narrative", objective: "ignored", access: "read" }, fresh.ctx)
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

for (const denied of ["question", "ask_options"]) {
  it.live(`low-confidence Chief refuses ${denied} before publishing options`, () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const permission = yield* Permission.Service
          const question = yield* Question.Service
          const queue = yield* asked()
          const input = yield* dispatch(dir, ambiguous)
          const tool = yield* (yield* ChiefRouteTool).init()
          const result = yield* tool
            .execute(
              { result: "narrative", objective: ambiguous, access: "read" },
              {
                ...input.ctx,
                ask: (request) =>
                  permission
                    .ask({
                      ...request,
                      sessionID: input.chat.id,
                      ruleset: Permission.fromConfig({ question: "allow", ask_options: "allow", [denied]: "deny" }),
                    })
                    .pipe(Effect.asVoid, Effect.orDie),
              },
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(Permission.DeniedError)
          expect(yield* question.list()).toHaveLength(0)
          expect(yield* Queue.size(queue)).toBe(0)
          expect(RayaChief.history((yield* sessions.get(input.chat.id)).metadata)).toHaveLength(0)
          expect(RayaChief.phase((yield* sessions.get(input.chat.id)).metadata)).toBe("route")
        }),
      { config: cfg },
    ),
  )
}
