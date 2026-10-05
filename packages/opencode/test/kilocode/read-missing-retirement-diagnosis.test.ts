import { EffectBridge } from "../../src/effect/bridge"
import { tool as aitool, jsonSchema } from "ai"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { nativeTools } from "../../src/session/llm/native-runtime"
import { SessionRetirement } from "../../src/kilocode/session/retirement"
import { completed } from "../../src/kilocode/session/tool-outcome"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Cause, Context, Effect, Exit, Layer, PlatformError } from "effect"
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
import { ReadTool } from "../../src/tool/read"
import { Instruction } from "../../src/session/instruction"
import { LSP } from "../../src/lsp/lsp"
import { Format } from "../../src/format"
import { BackgroundJob } from "../../src/background/job"
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
  Instruction.node,
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

it.effect("actual missing reads settle only after matching durable processor errors", () =>
  provideTmpdirProject(
    (dir) =>
      Effect.gen(function* () {
        const item = yield* setup(dir)
        const permission = yield* Permission.Service
        const bridge = yield* EffectBridge.make()
        const read = yield* ReadTool.pipe(Effect.flatMap(Tool.init))
        const fs = yield* FSUtil.Service
        const existing = path.join(dir, "existing.txt")
        yield* fs.writeFileString(existing, "actual synthetic file")
        const cases = [
          { call: "missing-read", spec: read, file: path.join(dir, "absent-synthetic-input.txt"), asks: true },
          { call: "missing-parent", spec: read, file: path.join(dir, "absent-parent", "file.txt"), asks: false },
          { call: "duplicate-hint", spec: read, file: path.join(dir, path.basename(dir), "existing.txt"), asks: false },
        ]
        for (const row of cases) {
          let asks = 0
          const args = { filePath: row.file }
          const tools = nativeTools(
            {
              read: aitool({
                inputSchema: jsonSchema({ type: "object" }),
                execute: (args, opts) =>
                  bridge.promise(
                    row.spec
                      .execute(args, {
                        sessionID: item.chat.id,
                        messageID: item.handle.message.id,
                        agent: "code",
                        abort: new AbortController().signal,
                        callID: opts.toolCallId,
                        messages: [],
                        ask: (request) => {
                          asks++
                          return permission
                            .ask({
                              ...request,
                              sessionID: item.chat.id,
                              ruleset: Permission.fromConfig({ read: "allow", external_directory: "allow" }),
                            })
                            .pipe(Effect.asVoid, Effect.orDie)
                        },
                        metadata: () => Effect.void,
                      })
                      .pipe(SessionRetirement.tool(item.chat.id, opts.toolCallId)),
                  ),
              }),
            },
            { messages: [], abort: new AbortController().signal },
          )
          const event = LLMEvent.toolCall({ id: row.call, name: "read", input: args })
          const dispatched = yield* ToolRuntime.dispatch(tools, event)
          expect(dispatched.result.type).toBe("error")
          const error = dispatched.events.find((event) => event.type === "tool-error")?.error
          expect(error).toBeInstanceOf(Error)
          expect(error instanceof Refusal).toBe(true)
          if (!(error instanceof Error)) throw new Error("Expected original tool error")
          expect(error).toMatchObject({ reason: "read-missing" })
          expect(error.message.startsWith("File not found:")).toBe(true)
          expect(asks > 0).toBe(row.asks)
          expect(SessionRetirement.snapshot().failures).toBe(1)
          expect(completed(item.chat.id, "foreign-call", error)).toBe(false)
          expect(completed("foreign-session", row.call, error)).toBe(false)
          expect(completed(item.chat.id, row.call, new Refusal("read-missing", error.message))).toBe(false)
          // The real processor cannot acknowledge the outcome without its matching original running tool part.
          yield* item.test.reply(
            LLMEvent.toolError({ id: row.call, name: "read", message: "synthetic missing file", error }),
          )
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
            parts.some((part) => part.type === "tool" && part.callID === row.call && part.state.status === "error"),
          ).toBe(true)
          expect(SessionRetirement.snapshot().failures).toBe(0)
          expect(completed(item.chat.id, row.call, error)).toBe(false)
        }
        expect(yield* fs.readFileString(existing)).toBe("actual synthetic file")
        expect(Exit.isSuccess(yield* Effect.exit(SessionRetirement.drain))).toBe(true)
      }),
    { git: true },
  ),
)

it.effect(
  "a controlled realPath access failure propagates unchanged through actual ReadTool rather than becoming missing-file refusal",
  () =>
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const permission = yield* Permission.Service
          const marker = new PlatformError.PlatformError(
            new PlatformError.SystemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "realPath",
            }),
          )
          // Fault injection is restricted to one filesystem boundary; stat/file/permission and the tool remain actual.
          const spec = yield* ReadTool.pipe(
            Effect.flatMap(Tool.init),
            Effect.provideService(FSUtil.Service, { ...fs, realPath: () => Effect.fail(marker) }),
          )
          const owner = SessionRetirement.make()
          const session = (yield* Session.Service).create({})
          const chat = yield* session
          const exit = yield* Effect.exit(
            owner.tool(
              chat.id,
              "access-failure",
              spec.execute(
                {
                  filePath: path.join(dir, "absent.txt"),
                },
                {
                  sessionID: chat.id,
                  messageID: MessageID.ascending(),
                  agent: "code",
                  abort: new AbortController().signal,
                  messages: [],
                  metadata: () => Effect.void,
                  ask: (request) =>
                    permission
                      .ask({
                        ...request,
                        sessionID: chat.id,
                        ruleset: Permission.fromConfig({ read: "allow", external_directory: "allow" }),
                      })
                      .pipe(Effect.asVoid, Effect.orDie),
                },
              ),
            ),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (!Exit.isFailure(exit)) throw new Error("Expected original access failure")
          expect(Cause.squash(exit.cause)).toBe(marker)
          expect(Cause.squash(exit.cause)).not.toBeInstanceOf(Refusal)
          expect(completed(chat.id, "access-failure", marker)).toBe(false)
          expect(Exit.isFailure(yield* Effect.exit(owner.drain))).toBe(true)
        }),
      { git: true },
    ),
)

test("generic identical-message and mixed-finalizer missing-file errors remain sticky", async () => {
  const generic = new Error("File not found: synthetic")
  const owner = SessionRetirement.make()
  await Effect.runPromiseExit(owner.tool("synthetic", "generic", Effect.die(generic)))
  expect(completed("synthetic", "generic", generic)).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(owner.drain))).toBe(true)
  const mixed = SessionRetirement.make()
  const typed = new Refusal("read-missing", generic.message)
  await Effect.runPromiseExit(
    mixed.tool(
      "synthetic",
      "mixed",
      Effect.die(typed).pipe(Effect.ensuring(Effect.die(new Error("synthetic storage finalizer failed")))),
    ),
  )
  expect(mixed.completed("synthetic", "mixed", typed)).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(mixed.drain))).toBe(true)
})
