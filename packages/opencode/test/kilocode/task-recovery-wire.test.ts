import { expect } from "bun:test"
import { asSchema } from "ai"
import { createRequire } from "node:module"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageID, PartID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { RayaChief } from "@/kilocode/chief"
import { ChiefVerification } from "@/kilocode/chief/verification"
import { RayaGoal } from "@/kilocode/goal"
import { goalTools } from "@/kilocode/tool/goal"
import { ToolEnvelope } from "@/kilocode/provider/tool-envelope"
import { context, schemas } from "@/kilocode/provider/ollama-context"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const model = ProviderTest.model()
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      Config.node,
      RuntimeFlags.node,
      EventV2Bridge.node,
      Session.node,
      SessionProjector.node,
      SessionPrompt.node,
      SessionProcessor.node,
      ToolRegistry.node,
      Truncate.node,
      Permission.node,
      Plugin.node,
      MCP.node,
      Storage.node,
      FSUtil.node,
      Git.node,
      Database.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

it.instance(
  "actual recovery factory advertises the retained ID after a rejected Goal audit",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const jobs = yield* BackgroundJob.Service
      const agents = yield* Agent.Service
      const prompts = yield* SessionPrompt.Service
      const processors = yield* SessionProcessor.Service
      const plugin = yield* Plugin.Service
      const ctx = yield* InstanceState.context
      const agent = yield* agents.get("auto")
      if (!agent) throw new Error("Actual Auto agent required")
      const parent = yield* sessions.create()
      const request = "Delegate writing the complete fixture and verify the saved file"
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: parent.id,
        role: "user",
        agent: "auto",
        model: { providerID: model.providerID, modelID: model.id },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: user.id,
        type: "text",
        text: request,
      })
      const assistant = (id = MessageID.ascending(), sessionID = parent.id, parentID = user.id) => ({
        id,
        sessionID,
        parentID,
        role: "assistant" as const,
        agent: "auto",
        mode: "auto",
        cost: 0,
        path: { cwd: ctx.directory, root: ctx.directory },
        providerID: model.providerID,
        modelID: model.id,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      const source = yield* sessions.updateMessage(assistant())
      const child = yield* sessions.create({ parentID: parent.id })
      const initial = yield* sessions.updateMessage({ ...user, id: MessageID.ascending(), sessionID: child.id })
      const completed = Date.now()
      const terminal = yield* sessions.updateMessage({
        ...assistant(MessageID.ascending(), child.id, initial.id),
        finish: "stop",
        time: { created: completed, completed },
      })
      const call = "completed-owned-worker"
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: source.id,
        type: "tool",
        tool: "task",
        callID: call,
        state: {
          status: "completed",
          input: { brief: { objective: request } },
          output: "Worker summary",
          title: "Worker completed",
          metadata: { sessionId: child.id, childMessageID: initial.id },
          time: { start: completed, end: completed },
        },
      })
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { background: false },
        origin: {
          sessionID: parent.id,
          messageID: source.id,
          callID: call,
          childSessionID: child.id,
          childMessageID: initial.id,
        },
        run: Effect.succeed("Worker summary"),
      })
      expect((yield* jobs.wait({ id: child.id })).info?.status).toBe("completed")
      const goals = RayaGoal.make({ sessions, storage })
      const goal = yield* goals.create(parent.id, request)
      const observed = Date.now()
      yield* sessions.setMetadata({
        sessionID: parent.id,
        metadata: {
          [RayaChief.requestKey]: request,
          [RayaChief.phaseKey]: "goal",
          [ChiefVerification.recovery]: {
            version: 1,
            kind: "foreground",
            userID: user.id,
            messageID: source.id,
            callID: call,
            requestSHA: digest({ tool: "request", state: request }),
            child: { sessionID: child.id, inputID: initial.id, messageID: terminal.id, completedAt: completed },
            goal: {
              status: "active",
              digest: digest({ tool: "goal", state: goal }),
              intent: goal.intent,
              revision: goal.revision,
            },
            at: observed,
          },
        },
      })
      const audit = yield* sessions.updateMessage(assistant())
      const update = yield* goalTools(goals, sessions).update.pipe(Effect.flatMap(Tool.init))
      const input = { status: "complete" as const, summary: "Worker summary", requirements: [] }
      const result = yield* update.execute(input, {
        sessionID: parent.id,
        messageID: audit.id,
        callID: "audit",
        agent: "auto",
        abort: new AbortController().signal,
        messages: [],
        ask: () => Effect.void,
        metadata: () => Effect.void,
      })
      expect(result.title).toBe("Completion audit rejected")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: audit.id,
        type: "tool",
        tool: "update_goal",
        callID: "audit",
        state: {
          status: "completed",
          input,
          title: result.title,
          output: result.output,
          metadata: result.metadata,
          time: { start: observed, end: Date.now() },
        },
      })
      const current = yield* sessions.updateMessage(assistant())
      const processor = yield* processors.create({ assistantMessage: current, sessionID: parent.id, model })
      const catalog = yield* SessionTools.resolve({
        agent,
        model,
        session: yield* sessions.get(parent.id),
        processor,
        messages: yield* sessions.messages({ sessionID: parent.id }),
        bypassAgentCheck: false,
        memoryCache: {},
        promptOps: {
          cancel: prompts.cancel,
          resolvePromptParts: prompts.resolvePromptParts,
          prompt: (input) => prompts.prompt(input).pipe(Effect.orDie),
        },
      })
      expect(catalog.task.description).toContain(`task_id="${child.id}"`)
      expect(catalog.task.description).toContain("supply a concrete correction objective")
      const prepared = yield* LLMRequestPrep.prepare({
        user,
        sessionID: parent.id,
        model,
        agent,
        tools: catalog,
        system: [],
        messages: [{ role: "user", content: request }],
        provider: ProviderTest.info({}, model),
        auth: undefined,
        plugin,
        flags: yield* RuntimeFlags.Service,
        isWorkflow: false,
      })
      const require = createRequire(import.meta.url)
      const Constructor: new (opts: { strict: boolean }) => { compile(schema: unknown): (input: unknown) => boolean } =
        createRequire(require.resolve("effect/package.json"))("ajv/dist/2020")
      const validator = new Constructor({ strict: false })
      const parameters = asSchema(prepared.tools.task.inputSchema).jsonSchema
      expect(prepared.tools.update_goal).toBeDefined()
      const options = context(
        { localInference: true, localInferenceAPI: "ollama", localInferenceToolFormat: "completion-envelope-v1" },
        model,
        prepared.tools,
      )
      const snapshot = schemas(options)?.find((row) => row.name === "task")
      expect(snapshot?.parameters).toEqual({ ...parameters })
      if (!snapshot) throw new Error("Original Ollama Task snapshot required")
      const definitions = [
        { function: { name: "task", description: prepared.tools.task.description, parameters: { ...parameters } } },
      ]
      const validate = validator.compile(parameters)
      const local = validator.compile(snapshot.parameters)
      const envelope = validator.compile(ToolEnvelope.schema(definitions, "required"))
      for (const input of [
        { brief: { objective: "Perform the missing write" } },
        { task_id: child.id },
        { task_id: "ses_foreign", prompt: "Correct the saved work" },
      ]) {
        expect(validate(input)).toBe(false)
        expect(local(input)).toBe(false)
        expect(envelope({ kind: "tool", name: "task", arguments: input })).toBe(false)
      }
      const correction = { task_id: child.id, brief: { objective: "Perform missing write and read the saved file" } }
      expect(validate(correction)).toBe(true)
      expect(local(correction)).toBe(true)
      expect(envelope({ kind: "tool", name: "task", arguments: correction })).toBe(true)
      expect(ToolEnvelope.guide(definitions)).toContain(child.id)
      expect(ToolEnvelope.guide(definitions)).toContain("supply a concrete correction objective")
      expect(yield* sessions.children(parent.id)).toHaveLength(1)
    }),
  { timeout: 30_000 },
)
