import { afterAll, expect } from "bun:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { Deferred, Effect, Exit, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { RayaGoal } from "@/kilocode/goal"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { goalTools } from "@/kilocode/tool/goal"
import * as GoalGate from "@/kilocode/goal/tool-gate"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { ToolRegistry } from "@/tool/registry"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { MessageID } from "@/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { database, storage } from "./fixtures/effect-profile"
import * as GoalNative from "@/kilocode/goal/native"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { RayaChief } from "@/kilocode/chief"

const requests: Record<string, unknown>[] = []
const kinds = (value: unknown) =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      anyOf: Schema.Array(
        Schema.Struct({ properties: Schema.Struct({ kind: Schema.Struct({ const: Schema.String }) }) }),
      ),
    }),
  )(value).anyOf.map((row) => row.properties.kind.const)
const names = (value: unknown) =>
  value === undefined
    ? []
    : Schema.decodeUnknownSync(
        Schema.Struct({
          anyOf: Schema.Array(
            Schema.Struct({
              properties: Schema.Struct({ name: Schema.optional(Schema.Struct({ const: Schema.String })) }),
            }),
          ),
        }),
      )(value).anyOf.flatMap((row) => (row.properties.name ? [row.properties.name.const] : []))
const palette = (request: Record<string, unknown> | undefined) =>
  request?.format !== undefined
    ? names(request.format)
    : request?.tools === undefined
      ? []
      : Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })))(
          request.tools,
        ).map((row) => row.function.name)
const state = { phase: 0, file: "", fresh: false, queued: false, paused: false, routine: false, ordinary: false }
const endpoint = Bun.serve({
  port: 0,
  async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/chat")
    const body = await request.json()
    requests.push(body)
    const phase = state.phase++
    const previous = body.messages.findLast(
      (row: { role: string; content: string }) => row.role === "tool" && row.content.includes("GATE_REAL_FILE"),
    )
    const native = !state.routine
      ? undefined
      : phase === 0
        ? { kind: "tool", name: "get_goal", arguments: {} }
        : phase === 1
          ? { kind: "tool", name: "read", arguments: { filePath: state.file } }
          : phase === 2 && previous
            ? {
                kind: "tool",
                name: "update_goal",
                arguments: {
                  status: "complete",
                  requirements: [
                    {
                      criterionID: "read",
                      requirement: "Read the fixture",
                      passed: true,
                      evidence: [{ callID: JSON.parse(previous.content).toolCallId, summary: "Actual file read" }],
                    },
                  ],
                },
              }
            : undefined
    const content = state.ordinary
      ? undefined
      : state.routine
        ? native
        : state.paused
          ? undefined
          : phase === 0
            ? { kind: "tool", name: "create_goal", arguments: { objective: "Read the fixture" } }
            : phase === 1 || (state.queued && phase === 4) || (state.fresh && phase === 6)
              ? { kind: "tool", name: "read", arguments: { filePath: state.file } }
              : phase === 2
                ? {
                    kind: "tool",
                    name: "update_goal",
                    arguments: {
                      status: "complete",
                      requirements: [
                        {
                          requirement: "Read the fixture",
                          passed: true,
                          evidence: [{ callID: JSON.parse(previous.content).toolCallId, summary: "Actual file read" }],
                        },
                      ],
                    },
                  }
                : undefined
    const text = content
      ? JSON.stringify(content)
      : body.format
        ? JSON.stringify({ kind: "text", content: "DONE" })
        : "DONE"
    return new Response(
      [
        { model: body.model, message: { role: "assistant", content: text }, done: false },
        { model: body.model, done: true, done_reason: "stop", prompt_eval_count: 8, eval_count: 3 },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    )
  },
})
process.env.RAYA_ENVELOPE_TEST_ORIGIN = endpoint.url.origin
afterAll(async () => {
  await endpoint.stop(true)
  delete process.env.RAYA_ENVELOPE_TEST_ORIGIN
  await disposeAllInstances()
})
const flags = LayerNode.make({
  service: RuntimeFlags.Service,
  layer: RuntimeFlags.layer({ experimentalNativeLlm: true, experimentalEventSystem: true }),
  deps: [],
})
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionPrompt.node,
      SessionProjector.node,
      Storage.node,
      FSUtil.node,
      Provider.node,
      RuntimeFlags.node,
      Truncate.node,
      Agent.node,
      Config.node,
      Permission.node,
      MCP.node,
      Plugin.node,
      ToolRegistry.node,
      SessionProcessor.node,
      CrossSpawnSpawner.node,
      Database.node,
      EventV2Bridge.node,
    ]),
    [
      [RuntimeFlags.node, flags],
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)
it.instance(
  "a native brief Auto routine retains its goal-first palette while ordinary Auto keeps Chief routing",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const instance = yield* TestInstance
      const goals = RayaGoal.make({ storage, database, sessions })
      const model = { providerID: ProviderV2.ID.make("qwen-local"), modelID: ModelV2.ID.make("fixture") }
      const done = yield* Deferred.make<void, unknown>()
      state.phase = 0
      state.fresh = false
      state.queued = false
      state.paused = false
      state.routine = true
      state.ordinary = false
      state.file = path.join(instance.directory, "routine.txt")
      requests.length = 0
      yield* Effect.promise(() => writeFile(state.file, "GATE_REAL_FILE", "utf8"))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.routine = false
          state.ordinary = false
          state.phase = 0
          requests.length = 0
        }),
      )
      // The real runner creates the session, immutable snapshot and prearmed Goal,
      // and invokes this actual prompt under its acquired execution owner.
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions,
        continuation: (run) =>
          Effect.gen(function* () {
            const goal = yield* goals.get(run.sessionID)
            if (!goal) throw new Error("Expected native prearmed routine Goal")
            // Match GoalContinuation.proceed -> launch: reserve and start the exact
            // native dispatch before SessionPrompt receives its owned message.
            const queued = yield* goals.continued(run.sessionID, goal.intent)
            if (!queued?.dispatch) throw new Error("Expected queued native routine dispatch")
            const started = yield* goals.dispatched(run.sessionID, queued.dispatch.id)
            if (!started?.dispatch?.messageID || started.dispatch.phase !== "started")
              throw new Error("Expected started native routine dispatch")
            const result = yield* prompt
              .prompt({
                sessionID: run.sessionID,
                messageID: started.dispatch.messageID,
                goalQueuedAt: started.dispatch.queuedAt,
                agent: "auto",
                model,
                goalObjective: started.objective,
                parts: [{ type: "text", text: started.objective, synthetic: true }],
              })
              .pipe(Effect.asVoid, Effect.exit)
            yield* Deferred.done(done, result)
            if (Exit.isFailure(result)) yield* Effect.failCause(result.cause)
          }).pipe(Effect.asVoid, Effect.orDie),
      })
      const worker = yield* runner.tasks.create({
        name: "Native brief Auto palette",
        role: "briefer",
        objective: `Read ${state.file} and return DONE every time this standing job runs.`,
        output: {
          destination: "conversation",
          description: "Return DONE after reading the actual fixture.",
          criteria: [{ id: "read", description: "Read the fixture", verification: "Cite the actual full native Read" }],
        },
        capabilities: [],
        memoryScope: "session",
        schedule: { kind: "manual" },
        access: "brief",
        tools: ["read"],
        mode: "auto",
        model: { providerID: "qwen-local", id: "fixture" },
        dir: instance.directory,
      })
      const run = yield* runner.fire(worker.id)
      yield* Deferred.await(done).pipe(Effect.timeout("20 seconds"))
      const session = yield* sessions.get(run.sessionID)
      const snapshot = yield* RayaTaskSnapshot.make({ storage }).find(run.id)
      expect(snapshot?.definition.access).toBe("brief")
      expect(snapshot?.definition.tools).toEqual(["read"])
      expect(snapshot?.definition.mode).toBe("auto")
      expect(snapshot?.sessionID).toBe(session.id)
      const goal = yield* goals.get(session.id)
      const rows = yield* sessions.messages({ sessionID: session.id })
      console.error(
        "native routine Auto fixture diagnostics",
        JSON.stringify({
          phase: goal?.dispatch?.phase,
          outcome: goal?.dispatch?.outcome,
          palettes: requests.map((request) => palette(request)),
          errors: rows
            .filter((row) => row.info.role === "assistant")
            .map((row) => ({ id: row.info.id, error: row.info.role === "assistant" ? row.info.error : undefined })),
        }),
      )
      expect(goal?.routine?.runID).toBe(run.id)
      expect(goal?.status).toBe("complete")
      expect(goal?.auditAttempt?.accepted).toBe(true)
      expect(goal?.audit?.requirements[0]?.criterionID).toBe("read")
      expect(goal?.audit?.requirements[0]?.passed).toBe(true)
      expect(RayaChief.routine(goal?.objective)).toBe(true)
      expect(goal?.objective).toContain("Report evidence for each criterion")
      expect(requests).toHaveLength(4)
      expect(names(requests[0]?.format)).toEqual(["get_goal"])
      expect(names(requests[1]?.format)).toContain("read")
      expect(names(requests[1]?.format)).toContain("update_goal")
      for (const request of requests)
        for (const name of names(request.format)) expect(["get_goal", "update_goal", "read"]).toContain(name)
      expect(requests[3]?.tools).toBeUndefined()
      expect(requests[3]?.format).toBeUndefined()
      const tools = rows.flatMap((row) => row.parts).filter((part) => part.type === "tool")
      expect(tools.map((part) => part.tool)).toEqual(["get_goal", "read", "update_goal"])
      expect(tools.every((part) => part.state.status === "completed")).toBe(true)
      const read = tools.find((part) => part.tool === "read")
      expect(read?.state.status === "completed" && read.state.metadata.rayaReadContent).toEqual(
        expect.objectContaining({ complete: true, text: "GATE_REAL_FILE" }),
      )
      const answer = rows.findLast((row) => row.info.role === "assistant")
      expect(answer?.info.role === "assistant" && answer.info.finish).toBe("stop")
      expect(
        answer?.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      ).toBe("DONE")

      state.routine = false
      state.ordinary = true
      state.phase = 0
      requests.length = 0
      const ordinary = yield* sessions.create({ title: "Ordinary Auto Chief control" })
      yield* prompt.prompt({
        sessionID: ordinary.id,
        agent: "auto",
        model,
        parts: [{ type: "text", text: "Report evidence from my project every morning." }],
      })
      expect(requests).toHaveLength(1)
      expect(palette(requests[0])).toEqual(["inspect_routines"])
      expect((yield* sessions.get(ordinary.id)).metadata?.rayaRoutine).toBeUndefined()
    }),
  {
    config: {
      snapshot: false,
      formatter: false,
      lsp: false,
      enabled_providers: ["qwen-local"],
      provider: {
        "qwen-local": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${endpoint.url}v1`, localInference: true, localInferenceAPI: "ollama" },
          models: { fixture: { name: "Gate fixture", limit: { context: 32768, output: 1024 } } },
        },
      },
      permission: { "*": "allow" },
      agent: { auto: { mode: "primary", steps: 8, permission: { "*": "allow" } } },
    },
  },
  45000,
)
it.instance(
  "a host-prearmed goal owns its first real turn and releases accepted synthesis",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const storage = yield* Storage.Service
      const instance = yield* TestInstance
      const goals = RayaGoal.make({ storage, sessions })
      const session = yield* sessions.create({ title: "Prearmed Goal gate" })
      state.phase = 1
      state.fresh = false
      state.queued = false
      state.paused = false
      requests.length = 0
      state.file = path.join(instance.directory, "prearmed.txt")
      yield* Effect.promise(() => writeFile(state.file, "GATE_REAL_FILE", "utf8"))
      const armed = yield* goals.create(session.id, "Read the fixture and provide DONE")
      expect(armed.startMessageID).toBeUndefined()
      expect(armed.startAfter).toBeDefined()
      yield* Effect.addFinalizer(() =>
        goals.clear(session.id).pipe(
          Effect.andThen(
            Effect.sync(() => {
              state.phase = 0
              requests.length = 0
            }),
          ),
        ),
      )
      const reply = yield* prompt.prompt({
        sessionID: session.id,
        agent: "gate",
        model: { providerID: ProviderV2.ID.make("qwen-local"), modelID: ModelV2.ID.make("fixture") },
        parts: [{ type: "text", text: armed.objective }],
      })
      const saved = yield* goals.get(session.id)
      expect(saved?.status).toBe("complete")
      expect(saved?.auditAttempt?.accepted).toBe(true)
      expect(saved?.startMessageID).toBeUndefined()
      expect(saved?.startAfter).toBe(armed.startAfter)
      expect(saved?.dispatch?.messageID).toBeDefined()
      const rows = yield* sessions.messages({ sessionID: session.id })
      const users = rows.filter((row) => row.info.role === "user")
      expect(users).toHaveLength(1)
      expect(saved?.dispatch?.messageID).toBe(users[0]?.info.id)
      expect(reply.info.role === "assistant" && reply.info.parentID).toBe(users[0]?.info.id)
      expect(reply.parts.some((part) => part.type === "text" && part.text === "DONE")).toBe(true)
      expect(
        rows
          .flatMap((row) => row.parts)
          .filter((part) => part.type === "tool")
          .map((part) => part.tool),
      ).toEqual(["read", "update_goal"])
      expect(requests).toHaveLength(3)
      expect(requests[0]?.format).toBeDefined()
      expect(requests[1]?.format).toBeDefined()
      expect(kinds(requests[0]?.format)).not.toContain("text")
      expect(kinds(requests[1]?.format)).not.toContain("text")
      expect(requests[2]?.tools).toBeUndefined()
      expect(requests[2]?.format).toBeUndefined()
      expect(requests.every((request) => request.think === false)).toBe(true)
      for (const request of requests) expect(request.options).toEqual(expect.objectContaining({ num_ctx: 32768 }))
      expect(
        (yield* (yield* Provider.Service).getProvider(ProviderV2.ID.make("qwen-local"))).options
          .localInferenceToolFormat,
      ).toBeUndefined()
      expect(saved?.usage.continuations).toBe(0)
    }),
  {
    config: {
      snapshot: false,
      formatter: false,
      lsp: false,
      enabled_providers: ["qwen-local"],
      provider: {
        "qwen-local": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `${endpoint.url}v1`,
            localInference: true,
            localInferenceAPI: "ollama",
          },
          models: {
            fixture: {
              name: "Gate fixture",
              limit: { context: 32768, output: 1024 },
              options: { reasoningEffort: "none" },
            },
          },
        },
      },
      permission: { "*": "deny", read: "allow", create_goal: "allow", get_goal: "allow", update_goal: "allow" },
      agent: {
        gate: {
          mode: "primary",
          steps: 8,
          permission: { "*": "deny", read: "allow", create_goal: "allow", get_goal: "allow", update_goal: "allow" },
        },
      },
    },
  },
  45000,
)
it.instance(
  "user-control pause settles the owned turn before explicit resume",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const storage = yield* Storage.Service
      const goals = RayaGoal.make({ storage, sessions })
      const session = yield* sessions.create({ title: "Pause execution gate" })
      yield* goals.create(session.id, "Keep the original dispatch")
      yield* Effect.addFinalizer(() => goals.clear(session.id))
      const queued = yield* goals.continued(session.id)
      if (!queued?.dispatch?.messageID) throw new Error("Original dispatch missing")
      const dispatch = queued.dispatch
      const message = queued.dispatch.messageID
      yield* goals.dispatched(session.id, dispatch.id)
      yield* sessions.updateMessage({
        id: message,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "gate",
        model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("fixture") },
      })
      const definition = yield* goalTools(goals).update.pipe(Effect.flatMap(Tool.init))
      const current = () =>
        sessions.messages({ sessionID: session.id }).pipe(
          Effect.map((rows) => rows.findLast((row) => row.info.role === "user")?.info.id),
          Effect.orDie,
        )
      const check = yield* GoalGate.prepare(definition.jsonSchema, session.id, message, current)
      const tools = GoalGate.bind({}, check, Effect.runPromise)
      expect(yield* GoalGate.required(tools)).toBe(true)
      const options = { localInference: true, localInferenceAPI: "ollama", baseURL: `${endpoint.url}v1` }
      expect(GoalNative.admitted(yield* GoalGate.native(options, "@ai-sdk/openai-compatible", tools))).toBe(true)
      expect(GoalNative.admitted(yield* GoalGate.native(options, "@ai-sdk/openai-compatible", {}))).toBe(false)
      expect(GoalNative.admitted({ ...options, localInferenceToolFormat: "completion-envelope-v1" })).toBe(false)
      const cloud = { ...options, localInference: false }
      expect(yield* GoalGate.native(cloud, "@ai-sdk/openai-compatible", tools)).toBe(cloud)
      const paused = yield* goals.control(session.id, "paused")
      expect(paused.pause).toBe("user-control")
      expect(yield* check()).toBe(true)
      expect(yield* GoalGate.required(tools)).toBe(false)
      expect(yield* GoalGate.native(options, "@ai-sdk/openai-compatible", tools)).toBe(options)
      const fresh = yield* GoalGate.prepare(definition.jsonSchema, session.id, message, current)
      expect(yield* fresh()).toBe(true)
      state.paused = true
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.paused = false
          state.phase = 0
          requests.length = 0
        }),
      )
      const reply = yield* prompt.loop({ sessionID: session.id })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools).toBeUndefined()
      expect(kinds(requests[0]?.format)).toEqual(["text"])
      expect(reply.parts.some((part) => part.type === "text" && part.text === "DONE")).toBe(true)
      // Exercise the same durable acknowledgement used by the actual TurnClose subscriber.
      const settled = yield* goals.finished(session.id, reply.info.id)
      expect(settled?.status).toBe("paused")
      expect(settled?.pause).toBe("user-control")
      expect(settled?.dispatch?.id).toBe(dispatch.id)
      expect(settled?.dispatch?.messageID).toBe(message)
      expect(settled?.dispatch?.phase).toBe("finished")
      expect(settled?.auditAttempt?.accepted).not.toBe(true)
      const parts = (yield* sessions.messages({ sessionID: session.id })).flatMap((row) => row.parts)
      expect(parts.filter((part) => part.type === "tool")).toEqual([])
      yield* goals.control(session.id, "active")
      expect(yield* check()).toBe(false)
      expect(yield* fresh()).toBe(false)
      const resumed = yield* goals.continued(session.id)
      expect(resumed?.status).toBe("active")
      expect(resumed?.objective).toBe(queued.objective)
      expect(resumed?.dispatch?.phase).toBe("queued")
      expect(resumed?.dispatch?.id).not.toBe(dispatch.id)
      expect(yield* check()).toBe(false)
      expect(yield* GoalGate.required(tools)).toBe(false)
      expect(yield* GoalGate.native(options, "@ai-sdk/openai-compatible", tools)).toBe(options)
    }),
  {
    config: {
      snapshot: false,
      formatter: false,
      lsp: false,
      enabled_providers: ["openai"],
      provider: {
        openai: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `${endpoint.url}v1`,
            localInference: true,
            localInferenceAPI: "ollama",
            localInferenceToolFormat: "completion-envelope-v1",
          },
          models: { fixture: { name: "Gate fixture", limit: { context: 32768, output: 1024 } } },
        },
      },
      permission: { "*": "deny", read: "allow", create_goal: "allow", get_goal: "allow", update_goal: "allow" },
      agent: {
        gate: {
          mode: "primary",
          steps: 8,
          permission: { "*": "deny", read: "allow", create_goal: "allow", get_goal: "allow", update_goal: "allow" },
        },
      },
    },
  },
  45000,
)
it.instance(
  "accepted original goal dispatch synthesizes without tools and new user input remains usable",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const storage = yield* Storage.Service
      const instance = yield* TestInstance
      const goals = RayaGoal.make({ storage, sessions })
      state.file = path.join(instance.directory, "gate.txt")
      yield* Effect.promise(() => writeFile(state.file, "GATE_REAL_FILE", "utf8"))
      const created = yield* sessions.create({ title: "Goal completion gate" })
      const turn = (text: string) =>
        prompt.prompt({
          sessionID: created.id,
          agent: "gate",
          model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("fixture") },
          parts: [{ type: "text", text }],
        })
      yield* turn("Create a goal, read the fixture, complete it and provide DONE")
      const saved = yield* goals.get(created.id)
      expect(saved?.status).toBe("complete")
      expect(saved?.auditAttempt?.accepted).toBe(true)
      expect(saved?.dispatch?.messageID).toBeDefined()
      if (!saved?.dispatch?.messageID) throw new Error("Actual goal dispatch missing")
      const definition = yield* goalTools(goals).update.pipe(Effect.flatMap(Tool.init))
      const check = yield* GoalGate.prepare(definition.jsonSchema, created.id, saved.dispatch.messageID, () =>
        sessions.messages({ sessionID: created.id }).pipe(
          Effect.map((rows) => rows.findLast((row) => row.info.role === "user")?.info.id),
          Effect.orDie,
        ),
      )
      expect(yield* check()).toBe(true)
      expect(yield* GoalGate.required(GoalGate.bind({}, check, Effect.runPromise))).toBe(false)
      expect(requests).toHaveLength(4)
      expect(requests[3]?.tools).toBeUndefined()
      expect(kinds(requests[3]?.format)).toEqual(["text"])
      const tools = (yield* sessions.messages({ sessionID: created.id }))
        .flatMap((row) => row.parts)
        .filter((row) => row.type === "tool")
      expect(tools.map((row) => row.tool)).toEqual(["create_goal", "read", "update_goal"])
      const completed = tools.find((row) => row.tool === "update_goal")
      if (!completed || completed.state.status !== "completed") throw new Error("Accepted Goal result missing")
      expect(completed.state.output).toContain("Preserve the user's requested final response")
      expect(completed.state.output).toContain("Copy required literal text character-for-character")
      expect(completed.state.output).toContain("compare the entire response with the required literal text")
      expect(completed.state.output).toContain(`Original goal objective: ${JSON.stringify(saved.objective)}`)
      const wire = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
      )(requests[3]?.messages)
      const returned = wire.findLast((row) => row.role === "tool")
      if (!returned) throw new Error("Actual completion tool projection missing")
      expect(JSON.parse(returned.content)).toEqual({ toolCallId: completed.callID, output: completed.state.output })
      // Exercise a genuine already queued callback through the original processor,
      // then let SessionPrompt finish the dispatch without retaining its refusal.
      const agents = yield* Agent.Service
      const provider = yield* Provider.Service
      const processors = yield* SessionProcessor.Service
      const agent = yield* agents.get("gate")
      if (!agent) throw new Error("Fixture agent missing")
      const model = yield* provider.getModel(ProviderV2.ID.make("openai"), ModelV2.ID.make("fixture"))
      const messages = yield* sessions.messages({ sessionID: created.id })
      const user = messages.findLast((row) => row.info.role === "user")?.info
      if (!user || user.role !== "user") throw new Error("Actual original user missing")
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        parentID: user.id,
        sessionID: created.id,
        role: "assistant",
        mode: agent.name,
        agent: agent.name,
        cost: 0,
        path: { cwd: instance.directory, root: instance.directory },
        providerID: model.providerID,
        modelID: model.id,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      const processor = yield* processors.create({ assistantMessage: assistant, sessionID: created.id, model })
      const catalog = yield* SessionTools.resolve({
        agent,
        model,
        session: yield* sessions.get(created.id),
        processor,
        messages,
        bypassAgentCheck: false,
        promptOps: {
          cancel: prompt.cancel,
          resolvePromptParts: prompt.resolvePromptParts,
          prompt: (input) => prompt.prompt(input).pipe(Effect.orDie),
        },
        memoryCache: {},
      })
      expect(yield* GoalGate.closed(catalog)).toBe(true)
      state.queued = true
      expect(
        yield* processor.process({
          user,
          agent,
          sessionID: created.id,
          system: [],
          messages: [{ role: "user", content: "A callback was queued before completion." }],
          tools: catalog,
          model,
        }),
      ).toBe("continue")
      yield* prompt.loop({ sessionID: created.id })
      const refusal = (yield* sessions.messages({ sessionID: created.id }))
        .flatMap((row) => row.parts)
        .find((row) => row.type === "tool" && row.messageID === assistant.id)
      expect(refusal?.type === "tool" && refusal.state.status === "error" && refusal.state.error).toContain(
        "Tool admission for this goal dispatch is closed",
      )
      expect(kinds(requests[5]?.format)).toEqual(["text"])
      const synthesis = (yield* sessions.messages({ sessionID: created.id })).at(-1)
      expect(synthesis?.parts.some((row) => row.type === "text" && row.text === "DONE")).toBe(true)
      expect(
        (yield* sessions.messages({ sessionID: created.id })).filter(
          (row) => row.info.role === "assistant" && row.info.error,
        ),
      ).toEqual([])
      state.fresh = true
      yield* turn("New user request: read the fixture again")
      const later = (yield* sessions.messages({ sessionID: created.id }))
        .flatMap((row) => row.parts)
        .filter((row) => row.type === "tool")
      expect(later.map((row) => row.tool)).toEqual(["create_goal", "read", "update_goal", "read", "read"])
      const read = later.at(-1)
      expect(read?.state.status).toBe("completed")
      expect(read?.state.status === "completed" && read.state.output).toContain("GATE_REAL_FILE")
      expect((yield* goals.get(created.id))?.intent).toBe(saved.intent)
      expect(requests[6]?.format).toBeDefined()
      expect(yield* GoalGate.closed(catalog)).toBe(false)
      expect(yield* GoalGate.required(catalog)).toBe(false)
      yield* goals.clear(created.id)
      yield* goals.create(created.id, "A new goal intent")
      expect(yield* check()).toBe(false)
      yield* goals.clear(created.id)
    }),
  {
    config: {
      snapshot: false,
      formatter: false,
      lsp: false,
      enabled_providers: ["openai"],
      provider: {
        openai: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `${endpoint.url}v1`,
            localInference: true,
            localInferenceAPI: "ollama",
            localInferenceToolFormat: "completion-envelope-v1",
          },
          models: { fixture: { name: "Gate fixture", limit: { context: 32768, output: 1024 } } },
        },
      },
      permission: { "*": "deny", read: "allow", create_goal: "allow", get_goal: "allow", update_goal: "allow" },
      agent: {
        gate: {
          mode: "primary",
          steps: 8,
          permission: { "*": "deny", read: "allow", create_goal: "allow", get_goal: "allow", update_goal: "allow" },
        },
      },
    },
  },
  45000,
)

it.instance("conversational reply goals do not acquire persistent tool enforcement", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const storage = yield* Storage.Service
    const goals = RayaGoal.make({ storage, sessions })
    const session = yield* sessions.create({ title: "Conversational reply gate" })
    yield* goals.create(session.id, "Answer once", undefined, undefined, undefined, undefined, undefined, "reply")
    yield* Effect.addFinalizer(() => goals.clear(session.id))
    const queued = yield* goals.continued(session.id)
    const message = queued?.dispatch?.messageID
    if (!message) throw new Error("Actual reply dispatch missing")
    const definition = yield* goalTools(goals).update.pipe(Effect.flatMap(Tool.init))
    const check = yield* GoalGate.prepare(definition.jsonSchema, session.id, message, () => Effect.succeed(message))
    const tools = GoalGate.bind({}, check, Effect.runPromise)
    expect(yield* GoalGate.required(tools)).toBe(false)
    expect(yield* GoalGate.closed(tools)).toBe(false)
  }),
)
