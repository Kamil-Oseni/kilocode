import { EffectBridge } from "../../src/effect/bridge"
import { tool as aitool, jsonSchema } from "ai"
import { Tool, InvalidArgumentsError } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { nativeTools } from "../../src/session/llm/native-runtime"
import { SessionRetirement } from "../../src/kilocode/session/retirement"
import { completed } from "../../src/kilocode/session/tool-outcome"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent, ToolRuntime, type LLMEvent as Event } from "@opencode-ai/llm"
import { Database } from "@opencode-ai/core/database/database"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Image } from "../../src/image/image"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "../../src/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { SyncEvent } from "../../src/sync"
import * as Log from "@opencode-ai/core/util/log"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { EditTool } from "../../src/tool/edit"
import { TaskTool } from "../../src/tool/task"
import { LSP } from "../../src/lsp/lsp"
import { Format } from "../../src/format"
import { BackgroundJob } from "../../src/background/job"
import { RayaChief } from "../../src/kilocode/chief"
import { PartID } from "../../src/session/schema"
import { Refusal } from "../../src/kilocode/session/tool-refusal"
import { FSUtil } from "@opencode-ai/core/fs-util"

await Log.init({ print: false })

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

type Script = Stream.Stream<Event, unknown>

class TestLLM extends Context.Service<
  TestLLM,
  {
    readonly reply: (...items: Event[]) => Effect.Effect<void>
    readonly script: (item: Script) => Effect.Effect<void>
  }
>()("@test/EmptyToolCallsLLM") {}

class State extends Context.Service<State, { readonly queue: Script[] }>()("@test/EmptyToolCallsState") {}

function model(selection = ref): Provider.Model {
  return {
    id: selection.modelID,
    providerID: selection.providerID,
    name: "Test",
    limit: { context: 128000, output: 4096 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    api: { id: selection.modelID, url: "http://127.0.0.1:1", npm: "@ai-sdk/openai" },
    options: {},
    headers: {},
    status: "active",
    release_date: "",
  }
}

function usage() {
  return {
    inputTokens: 100,
    outputTokens: 41,
    totalTokens: 141,
  }
}

const stateNode = LayerNode.make({
  service: State,
  layer: Layer.sync(State, () => State.of({ queue: [] })),
  deps: [],
})
const llmNode = LayerNode.make({
  service: LLM.Service,
  layer: Layer.effect(
    LLM.Service,
    Effect.gen(function* () {
      const state = yield* State
      return LLM.Service.of({ stream: () => state.queue.shift() ?? Stream.empty })
    }),
  ),
  deps: [stateNode],
})
const testNode = LayerNode.make({
  service: TestLLM,
  layer: Layer.effect(
    TestLLM,
    Effect.gen(function* () {
      const state = yield* State
      const push = (item: Script) => Effect.sync(() => state.queue.push(item)).pipe(Effect.asVoid)
      return TestLLM.of({ reply: (...items) => push(Stream.make(...items)), script: push })
    }),
  ),
  deps: [stateNode],
})
const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  Truncate.node,
  AgentSvc.node,
  Permission.node,
  Plugin.node,
  Config.node,
  SessionSummary.node,
  Image.node,
  SessionStatus.node,
  EventV2Bridge.node,
  Database.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LLM.node,
  LSP.node,
  Format.node,
  FSUtil.node,
  BackgroundJob.node,
  Provider.node,
  testNode,
])
const env = LayerNode.compile(root, [
  [LLM.node, llmNode],
  [RuntimeFlags.node, RuntimeFlags.layer()],
]).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, Bus.layer, SyncEvent.defaultLayer)))

const it = testEffect(env)

const setup = Effect.fn("SessionProcessorTest.setup")(function* (dir: string) {
  const test = yield* TestLLM
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const chat = yield* session.create({})
  const parent = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "code",
    model: ref,
    time: { created: Date.now() },
  })
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: chat.id,
    parentID: parent.id,
    mode: "code",
    agent: "code",
    path: { cwd: path.resolve(dir), root: path.resolve(dir) },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(msg)
  const mdl = model()
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
  const input: LLM.StreamInput = {
    user: parent as MessageV2.User,
    sessionID: chat.id,
    model: mdl,
    agent: { name: "code", mode: "primary", permission: [], options: {} },
    system: [],
    messages: [],
    tools: {},
  }
  return { test, session, chat, handle, input }
})

it.effect("durable processor handling settles actual permission and schema refusals through native SDK", () =>
  provideTmpdirProject(
    (dir) =>
      Effect.gen(function* () {
        const item = yield* setup(dir)
        const permission = yield* Permission.Service
        const bridge = yield* EffectBridge.make()
        const spec = yield* Tool.define(
          "refusal",
          Effect.succeed({
            description: "Exercise actual permission and parameter validation without external actions",
            parameters: Schema.Struct({ value: Schema.String }),
            execute: () =>
              permission
                .ask({
                  permission: "read",
                  patterns: ["input.txt"],
                  always: [],
                  metadata: {},
                  sessionID: item.chat.id,
                  ruleset: Permission.fromConfig({ read: "deny" }),
                })
                .pipe(
                  Effect.orDie,
                  Effect.as({ title: "Unreachable", metadata: { truncated: false }, output: "Unreachable" }),
                ),
          }),
        ).pipe(Effect.flatMap(Tool.init))
        const edit = yield* EditTool.pipe(Effect.flatMap(Tool.init))
        const task = yield* TaskTool.pipe(Effect.flatMap(Tool.init))
        const generic = yield* Tool.define(
          "generic",
          Effect.succeed({
            description: "Exercise a generic failure with the same business refusal wording",
            parameters: Schema.Struct({ value: Schema.String }),
            execute: () => Effect.die(new Error("The parent policy does not allow editing access for this child")),
          }),
        ).pipe(Effect.flatMap(Tool.init))
        const file = path.join(dir, "stale.txt")
        const fs = yield* FSUtil.Service
        yield* fs.writeFileString(file, "unchanged actual file")
        yield* item.session.setPermission({
          sessionID: item.chat.id,
          permission: Permission.fromConfig({ edit: "deny" }),
        })
        const cases: {
          call: string
          spec: Tool.Def
          args: Record<string, unknown>
          reason?: string
          sticky?: boolean
        }[] = [
          { call: "permission", spec, args: { value: "valid" } },
          { call: "schema", spec, args: { value: 7 } },
          {
            call: "stale",
            spec: edit,
            args: { filePath: file, oldString: "not the source", newString: "new text" },
            reason: "stale-edit",
          },
          {
            call: "authority",
            spec: task,
            args: { brief: { objective: "Edit the requested file" }, access: "edit" },
            reason: "parent-edit-policy",
          },
          { call: "session", spec: task, args: { brief: { objective: "Resume a task" }, task_id: "invalid-session" } },
          { call: "objective", spec: task, args: { access: "read" }, reason: "task-objective" },
          {
            call: "work",
            spec: task,
            args: { access: "read", brief: { objective: "Write the requested file" } },
            reason: "task-access",
          },
          { call: "generic", spec: generic, args: { value: "valid" }, sticky: true },
        ]
        for (const row of cases) {
          const call = row.call
          if (call === "work") {
            const request = "Write the requested file"
            yield* item.session.updatePart({
              id: PartID.ascending(),
              messageID: item.input.user.id,
              sessionID: item.chat.id,
              type: "text",
              text: request,
            })
            yield* item.session.setMetadata({
              sessionID: item.chat.id,
              metadata: {
                [RayaChief.phaseKey]: "task",
                [RayaChief.requestKey]: request,
                [RayaChief.pendingKey]: {
                  request,
                  userID: item.input.user.id,
                  access: "edit",
                  agent: "general",
                  role: "generalist",
                  needs_plan: false,
                  confidence: 1,
                  reason: "Requested work",
                  candidates: [],
                  prompted: false,
                  latency: 0,
                  chiefModel: "test/test-model",
                },
              },
            })
          }
          const args = row.args
          const tools = nativeTools(
            {
              refusal: aitool({
                inputSchema: jsonSchema({ type: "object" }),
                execute: (args, opts) =>
                  bridge.promise(
                    row.spec
                      .execute(args, {
                        sessionID: item.chat.id,
                        messageID: item.handle.message.id,
                        agent: call === "work" ? "auto" : "build",
                        abort: new AbortController().signal,
                        callID: opts.toolCallId,
                        messages: [],
                        ask: () => Effect.void,
                        metadata: () => Effect.void,
                      })
                      .pipe(SessionRetirement.tool(item.chat.id, opts.toolCallId)),
                  ),
              }),
            },
            { messages: [], abort: new AbortController().signal },
          )
          const event = LLMEvent.toolCall({ id: call, name: "refusal", input: args })
          const dispatched = yield* ToolRuntime.dispatch(tools, event)
          expect(dispatched.result.type).toBe("error")
          expect(SessionRetirement.snapshot().failures).toBe(1)
          const error = dispatched.events.find((event) => event.type === "tool-error")?.error
          if (row.reason) expect(error).toMatchObject({ reason: row.reason })
          if (call === "session") expect(error).toBeInstanceOf(InvalidArgumentsError)
          expect(completed(item.chat.id, "foreign-call", error)).toBe(false)
          expect(completed("foreign-session", call, error)).toBe(false)
          expect(completed(item.chat.id, call, new InvalidArgumentsError({ tool: "refusal", detail: "foreign" }))).toBe(
            false,
          )
          // A real processor event without the original running tool part cannot publish or acknowledge it.
          yield* item.test.reply(LLMEvent.toolError({ id: call, name: "refusal", message: "fixture refusal", error }))
          yield* item.handle.process(item.input)
          expect(SessionRetirement.snapshot().failures).toBe(1)
          yield* item.test.reply(
            LLMEvent.stepStart({ index: 0 }),
            event,
            ...dispatched.events,
            LLMEvent.stepFinish({ index: 0, reason: "stop", usage: usage() }),
            LLMEvent.finish({ reason: "stop", usage: usage() }),
          )
          yield* item.handle.process(item.input)
          const parts = yield* MessageV2.parts(item.handle.message.id)
          expect(
            parts.some((part) => part.type === "tool" && part.callID === call && part.state.status === "error"),
          ).toBe(true)
          expect(SessionRetirement.snapshot().failures).toBe(row.sticky ? 1 : 0)
          expect(completed(item.chat.id, call, error)).toBe(false)
        }
        expect(yield* fs.readFileString(file)).toBe("unchanged actual file")
        expect(Exit.isFailure(yield* Effect.exit(SessionRetirement.drain))).toBe(true)
      }),
    { git: true },
  ),
)

test("unpublished, foreign, mixed finalizer and owner failures remain sticky", async () => {
  const error = new InvalidArgumentsError({ tool: "synthetic", detail: "invalid" })
  const owner = SessionRetirement.make()
  const exit = await Effect.runPromiseExit(owner.tool("session", "call", Effect.die(error)))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(owner.completed("foreign", "call", error)).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(owner.drain))).toBe(true)
  const mixed = SessionRetirement.make()
  await Effect.runPromiseExit(
    mixed.tool(
      "session",
      "call",
      Effect.die(error).pipe(Effect.ensuring(Effect.die(new Error("actual finalizer failed")))),
    ),
  )
  expect(mixed.completed("session", "call", error)).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(mixed.drain))).toBe(true)
  const ordinary = SessionRetirement.make()
  await Effect.runPromiseExit(ordinary.run(() => Effect.die(new Error("owner publication failed"))))
  expect(ordinary.completed("session", "call", error)).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(ordinary.drain))).toBe(true)
})

test("closed business refusal kinds do not acknowledge generic lookalikes or mixed finalizers", async () => {
  expect(() => Reflect.construct(Refusal, ["unknown", "synthetic"])).toThrow("Invalid tool refusal reason")
  const generic = new Error("Could not find oldString in the file")
  expect(completed("session", "call", generic)).toBe(false)
  const error = new Refusal("stale-edit", generic.message)
  const owner = SessionRetirement.make()
  await Effect.runPromiseExit(owner.tool("session", "call", Effect.die(error)))
  expect(owner.completed("session", "call", new Refusal("stale-edit", error.message))).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(owner.drain))).toBe(true)
  const mixed = SessionRetirement.make()
  await Effect.runPromiseExit(
    mixed.tool("session", "call", Effect.die(error).pipe(Effect.ensuring(Effect.die(generic)))),
  )
  expect(mixed.completed("session", "call", error)).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(mixed.drain))).toBe(true)
})
