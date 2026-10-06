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
import { EditTool, replace } from "../../src/tool/edit"
import { TaskTool } from "../../src/tool/task"
import { LSP } from "../../src/lsp/lsp"
import { Format } from "../../src/format"
import { BackgroundJob } from "../../src/background/job"
import { RayaChief } from "../../src/kilocode/chief"
import { PartID } from "../../src/session/schema"
import { Refusal } from "../../src/kilocode/session/tool-refusal"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ChiefRouteTool } from "../../src/kilocode/tool/chief-route"
import { Question } from "../../src/question"
import { WriteTool } from "../../src/tool/write"
import { ReadTool } from "../../src/tool/read"
import { Instruction } from "../../src/session/instruction"
import { Storage } from "../../src/storage/storage"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import * as ExactWrite from "../../src/kilocode/tool/exact-write"

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
  Question.node,
  Instruction.node,
  Storage.node,
  Ripgrep.node,
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

it.effect(
  "durable processor handling settles actual permission and schema refusals through native SDK",
  () =>
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
          const chief = yield* ChiefRouteTool.pipe(Effect.flatMap(Tool.init))
          const writer = yield* WriteTool.pipe(Effect.flatMap(Tool.init))
          const reader = yield* ReadTool.pipe(Effect.flatMap(Tool.init))
          const lookalike = yield* Tool.define(
            "chief-lookalike",
            Effect.succeed({
              description: "Retain an unexpected routing failure with identical wording",
              parameters: Schema.Struct({}),
              execute: () => Effect.die(new Error("Auto routing requires at least one eligible specialist")),
            }),
          ).pipe(Effect.flatMap(Tool.init))
          const generic = yield* Tool.define(
            "generic",
            Effect.succeed({
              description: "Exercise a generic failure with the same business refusal wording",
              parameters: Schema.Struct({ value: Schema.String }),
              execute: () => Effect.die(new Error("No changes to apply: oldString and newString are identical.")),
            }),
          ).pipe(Effect.flatMap(Tool.init))
          const file = path.join(dir, "stale.txt")
          const fs = yield* FSUtil.Service
          yield* fs.writeFileString(file, "unchanged actual file")
          const source = path.join(dir, "exact-source.txt")
          const target = path.join(dir, "exact-target.txt")
          yield* fs.writeFileString(source, "a".repeat(48))
          const read = yield* reader.execute(
            { filePath: source },
            {
              sessionID: item.chat.id,
              messageID: item.handle.message.id,
              agent: "build",
              abort: new AbortController().signal,
              callID: "source-read",
              messages: [],
              ask: () => Effect.void,
              metadata: () => Effect.void,
            },
          )
          const block = read.output.match(
            /<file-content-json encoding="UTF-8" complete="true" bytes="(\d+)" sha256="([a-f0-9]{64})">\n(.*?)\n<\/file-content-json>/s,
          )
          expect(block).not.toBeNull()
          const content: unknown = JSON.parse(block![3])
          if (typeof content !== "string") throw new Error("Complete source Read must contain a JSON string")
          const exact = { bytes: Number(block![1]), sha256: block![2] }
          const lookalikeWrite = yield* Tool.define(
            "write-lookalike",
            Effect.succeed({
              description: "Preserve a generic error with identical exact-write wording",
              parameters: Schema.Struct({}),
              execute: () =>
                Effect.die(
                  new Error(
                    "Exact UTF-8 write refused: content bytes or SHA-256 differ from the expected Read evidence. Decode the complete file-content-json string exactly; check BOM, newline endings and final newline. No file was written.",
                  ),
                ),
            }),
          ).pipe(Effect.flatMap(Tool.init))
          const mixedWrite = yield* Tool.define(
            "write-finalizer",
            Effect.succeed({
              description: "Retain an actual exact-write refusal combined with a finalizer failure",
              parameters: Schema.Struct({}),
              execute: (_, ctx) =>
                writer
                  .execute({ filePath: target, content: content + "\n", exact }, ctx)
                  .pipe(Effect.ensuring(Effect.die(new Error("actual exact-write finalizer failed")))),
            }),
          ).pipe(Effect.flatMap(Tool.init))
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
            {
              call: "exact-newline",
              spec: writer,
              args: { filePath: target, content: content + "\n", exact },
              reason: "exact-write",
            },
            {
              call: "exact-equal-length",
              spec: writer,
              args: { filePath: target, content: "b".repeat(48), exact },
              reason: "exact-write",
            },
            {
              call: "exact-surrogate",
              spec: writer,
              args: { filePath: target, content: "\ud800", exact },
              reason: "exact-write",
            },
            {
              call: "exact-bound",
              spec: writer,
              args: { filePath: target, content: "x".repeat(8193), exact },
              reason: "exact-write",
            },
            {
              call: "no-change",
              spec: edit,
              args: { filePath: file, oldString: "", newString: "" },
              reason: "edit-no-change",
            },
            {
              call: "same-text",
              spec: edit,
              args: { filePath: file, oldString: "unchanged actual file", newString: "unchanged actual file" },
              reason: "edit-no-change",
            },
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
            {
              call: "session",
              spec: task,
              args: { brief: { objective: "Resume a task" }, task_id: "invalid-session" },
            },
            { call: "objective", spec: task, args: { access: "read" }, reason: "task-objective" },
            {
              call: "work",
              spec: task,
              args: { access: "read", brief: { objective: "Write the requested file" } },
              reason: "task-access",
            },
            {
              call: "chief-unavailable",
              spec: chief,
              args: { objective: "Inspect the desktop", access: "computer" },
              reason: "chief-no-eligible",
            },
            { call: "chief-lookalike", spec: lookalike, args: {}, sticky: true },
            { call: "write-lookalike", spec: lookalikeWrite, args: {}, sticky: true },
            { call: "write-finalizer", spec: mixedWrite, args: {}, sticky: true },
            { call: "generic", spec: generic, args: { value: "valid" }, sticky: true },
          ]
          let sticky = 0
          for (const row of cases) {
            const call = row.call
            if (call === "chief-unavailable") {
              yield* item.session.setMetadata({
                sessionID: item.chat.id,
                metadata: { [RayaChief.phaseKey]: "route", [RayaChief.requestKey]: "Inspect the desktop" },
              })
            }
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
            expect(SessionRetirement.snapshot().failures).toBe(sticky + 1)
            const error = dispatched.events.find((event) => event.type === "tool-error")?.error
            if (row.reason) expect(error).toMatchObject({ reason: row.reason })
            if (call.startsWith("exact-")) expect(yield* fs.exists(target)).toBe(false)
            if (call === "session") expect(error).toBeInstanceOf(InvalidArgumentsError)
            expect(completed(item.chat.id, "foreign-call", error)).toBe(false)
            expect(completed("foreign-session", call, error)).toBe(false)
            expect(
              completed(item.chat.id, call, new InvalidArgumentsError({ tool: "refusal", detail: "foreign" })),
            ).toBe(false)
            // A real processor event without the original running tool part cannot publish or acknowledge it.
            yield* item.test.reply(LLMEvent.toolError({ id: call, name: "refusal", message: "fixture refusal", error }))
            yield* item.handle.process(item.input)
            expect(SessionRetirement.snapshot().failures).toBe(sticky + 1)
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
            if (row.sticky) sticky++
            expect(SessionRetirement.snapshot().failures).toBe(sticky)
            expect(completed(item.chat.id, call, error)).toBe(false)
            if (call === "chief-unavailable") {
              expect(error).toBeInstanceOf(Refusal)
              expect(error).toMatchObject({ message: "Auto routing requires at least one eligible specialist" })
              const chat = yield* item.session.get(item.chat.id)
              expect(RayaChief.phase(chat.metadata)).toBe("route")
              expect(RayaChief.history(chat.metadata)).toEqual([])
            }
          }
          expect(yield* fs.readFileString(file)).toBe("unchanged actual file")
          expect(yield* fs.readFileString(source)).toBe(content)
          expect(yield* fs.exists(target)).toBe(false)
          expect(Exit.isFailure(yield* Effect.exit(SessionRetirement.drain))).toBe(true)
        }),
      {
        git: true,
        config: { permission: { desktop_observe: "deny", desktop_click: "deny", desktop_type: "deny" } },
      },
    ),
  // Cold Windows processor setup and the real durable refusal cases exceed Bun's default five seconds.
  30_000,
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
  expect(() => replace("unchanged", "unchanged", "unchanged")).toThrow(Refusal)
  const generic = new Error("No changes to apply: oldString and newString are identical.")
  expect(completed("session", "call", generic)).toBe(false)
  const error = new Refusal("edit-no-change", "No changes to apply: oldString and newString are identical.")
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

test("unavailable Chief refusal preserves generic and mixed retirement failures", async () => {
  const error = (() => {
    try {
      RayaChief.route({ request: "Inspect the desktop", agents: [], access: "computer" })
    } catch (err) {
      return err
    }
    throw new Error("Expected the actual routing guard to refuse")
  })()
  expect(error).toBeInstanceOf(Refusal)
  expect(error).toMatchObject({ reason: "chief-no-eligible" })
  const generic = new Error("Auto routing requires at least one eligible specialist")
  expect(completed("session", "call", generic)).toBe(false)
  const owner = SessionRetirement.make()
  await Effect.runPromiseExit(owner.tool("session", "call", Effect.die(error)))
  expect(owner.completed("foreign", "call", error)).toBe(false)
  expect(owner.completed("session", "call", generic)).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(owner.drain))).toBe(true)
  const mixed = SessionRetirement.make()
  await Effect.runPromiseExit(
    mixed.tool("session", "call", Effect.die(error).pipe(Effect.ensuring(Effect.die(generic)))),
  )
  expect(mixed.completed("session", "call", error)).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(mixed.drain))).toBe(true)
})

test("exact-write refusal keeps unpublished, foreign and mixed failures sticky", async () => {
  const error = (() => {
    try {
      ExactWrite.check("literal\n", { bytes: 7, sha256: "0".repeat(64) })
    } catch (err) {
      return err
    }
    throw new Error("Expected the actual exact-write validation guard to refuse")
  })()
  expect(error).toBeInstanceOf(Refusal)
  expect(error).toMatchObject({ reason: "exact-write" })
  if (!(error instanceof Refusal)) throw new Error("Actual exact-write guard did not emit Refusal")
  const generic = new Error(error.message)
  expect(completed("session", "call", generic)).toBe(false)
  const owner = SessionRetirement.make()
  await Effect.runPromiseExit(owner.tool("session", "call", Effect.die(error)))
  expect(owner.completed("foreign", "call", error)).toBe(false)
  expect(owner.completed("session", "foreign", error)).toBe(false)
  expect(owner.completed("session", "call", generic)).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(owner.drain))).toBe(true)
  const mixed = SessionRetirement.make()
  await Effect.runPromiseExit(
    mixed.tool("session", "call", Effect.die(error).pipe(Effect.ensuring(Effect.die(generic)))),
  )
  expect(mixed.completed("session", "call", error)).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(mixed.drain))).toBe(true)
})
