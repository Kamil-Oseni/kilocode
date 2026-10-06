import { expect } from "bun:test"
import { asSchema } from "ai"
import { createRequire } from "node:module"
import path from "node:path"
import { Effect, Schema } from "effect"
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
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { TaskAuthority } from "@/kilocode/tool/task-authority"
import { ReadTool } from "@/tool/read"
import * as Artifact from "@/kilocode/goal/artifact"
import { RayaChief } from "@/kilocode/chief"
import { ChiefVerification } from "@/kilocode/chief/verification"
import { RayaGoal } from "@/kilocode/goal"
import { goalTools } from "@/kilocode/tool/goal"
import * as GoalGate from "@/kilocode/goal/tool-gate"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
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
      Instruction.node,
      LSP.node,
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
      const goals = RayaGoal.make({ sessions, storage })
      const goal = yield* goals.create(parent.id, request)
      const source = yield* sessions.updateMessage(assistant())
      const child = yield* sessions.create({ parentID: parent.id })
      const initial = yield* sessions.updateMessage({
        ...user,
        id: MessageID.ascending(),
        sessionID: child.id,
        time: { created: Date.now() },
      })
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
          metadata: { parentSessionId: parent.id, sessionId: child.id, childMessageID: initial.id },
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
      const fs = yield* FSUtil.Service
      const inputfile = path.join(ctx.directory, "source.txt")
      const outputfile = path.join(ctx.directory, "target.txt")
      yield* fs.writeFileString(inputfile, "a".repeat(48))
      yield* fs.writeFileString(outputfile, "a".repeat(48) + "\n")
      const baseline = yield* Artifact.capture(fs, inputfile)
      if (baseline.status !== "captured") throw new Error("Actual source revision required")
      yield* goals.edit(parent.id, {
        expectedIntent: goal.intent,
        criteria: [
          {
            id: "bytes",
            description: "Preserve the exact source bytes",
            verification: "Read both raw files",
            check: {
              kind: "byte-equality",
              source: {
                path: inputfile,
                canonical: baseline.canonical,
                sha256: baseline.sha256,
                bytes: baseline.bytes,
              },
              target: { path: outputfile, canonical: outputfile },
            },
          },
        ],
      })
      const reader = yield* ReadTool.pipe(Effect.flatMap(Tool.init))
      for (const [index, file] of [inputfile, outputfile].entries()) {
        const captured = yield* reader.execute(
          { filePath: file },
          {
            sessionID: child.id,
            messageID: terminal.id,
            callID: `read-${index}`,
            agent: "code",
            abort: new AbortController().signal,
            messages: [],
            ask: () => Effect.void,
            metadata: () => Effect.void,
          },
        )
        expect(captured.output).toContain(`<file-content-json`)
        expect(captured.output).toContain(`bytes="${index === 0 ? 48 : 49}"`)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.id,
          messageID: terminal.id,
          type: "tool",
          tool: "read",
          callID: `read-${index}`,
          state: {
            status: "completed",
            input: { filePath: file },
            output: captured.output,
            title: captured.title,
            metadata: captured.metadata,
            time: { start: Date.now(), end: Date.now() },
          },
        })
      }
      const selected = yield* goals.get(parent.id)
      if (!selected) throw new Error("Current goal required")
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
              digest: digest({ tool: "goal", state: selected }),
              intent: selected.intent,
              revision: selected.revision,
            },
            at: observed,
          },
        },
      })
      const audit = yield* sessions.updateMessage(assistant())
      const update = yield* goalTools(goals, sessions).update.pipe(Effect.flatMap(Tool.init))
      const input = {
        status: "complete" as const,
        summary: "Worker summary",
        requirements: [
          {
            criterionID: "bytes",
            requirement: "Preserve the exact source bytes",
            passed: true,
            evidence: [
              { callID: "read-0", sessionID: child.id, messageID: terminal.id, summary: "Read source" },
              { callID: "read-1", sessionID: child.id, messageID: terminal.id, summary: "Read target" },
            ],
          },
        ],
      }
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
      expect(result.output).toContain("exactly the saved original SHA-256 and byte count")
      expect(result.output).toContain("<task_recovery>")
      expect(result.output).toContain(`"task_id":"${child.id}"`)
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
      const get = yield* goalTools(goals, sessions).get.pipe(Effect.flatMap(Tool.init))
      const read = yield* get.execute(
        {},
        {
          sessionID: parent.id,
          messageID: current.id,
          callID: "read-goal",
          agent: "auto",
          abort: new AbortController().signal,
          messages: [],
          ask: () => Effect.void,
          metadata: () => Effect.void,
        },
      )
      const recovery = JSON.parse(read.output).recovery
      expect(recovery.task_id).toBe(child.id)
      expect(recovery.example).toContain(`"task_id":"${child.id}"`)
      expect(recovery.example).toContain("final newline")
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
      const raw = catalog.task.description?.match(/<task_recovery>([^\n]+)<\/task_recovery>/)?.[1]
      if (!raw) throw new Error("Actual Task factory omitted its structured recovery call")
      const handoff = Schema.decodeUnknownSync(
        Schema.Struct({
          kind: Schema.Literal("tool"),
          name: Schema.Literal("task"),
          arguments: Schema.Struct({ task_id: SessionID, prompt: Schema.String }),
        }),
      )(JSON.parse(raw))
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
      expect(prepared.tools.task.description).toContain(raw)
      expect(validate(handoff.arguments)).toBe(true)
      expect(local(handoff.arguments)).toBe(true)
      expect(envelope(handoff)).toBe(true)
      expect(ToolEnvelope.guide(definitions)).toContain(child.id)
      expect(ToolEnvelope.guide(definitions)).toContain("supply a concrete correction objective")
      expect(yield* sessions.children(parent.id)).toHaveLength(1)
      const opts = {
        sessionID: parent.id,
        messageID: current.id,
        callID: "negative-goal",
        agent: "auto",
        abort: new AbortController().signal,
        messages: [],
        ask: () => Effect.void,
        metadata: () => Effect.void,
      }
      expect(JSON.parse((yield* get.execute({}, { ...opts, agent: "code" })).output).recovery).toBeUndefined()
      const isolated = yield* Effect.promise(() =>
        Effect.runPromise(get.execute({}, opts).pipe(Effect.provideService(InstanceRef, ctx))),
      )
      expect(JSON.parse(isolated.output).recovery).toBeUndefined()
      const metadata = (yield* sessions.get(parent.id)).metadata ?? {}
      const proof = Schema.decodeUnknownSync(ChiefVerification.Observation)(metadata?.[ChiefVerification.recovery])
      const foreign = yield* sessions.create()
      if (!proof.child) throw new Error("Retained child proof required")
      yield* sessions.setMetadata({
        sessionID: parent.id,
        metadata: {
          ...metadata,
          [ChiefVerification.recovery]: {
            ...proof,
            child: { ...proof.child, sessionID: foreign.id },
          },
        },
      })
      const denied = yield* get.execute({}, opts).pipe(Effect.exit)
      expect(denied._tag).toBe("Failure")
      yield* sessions.setMetadata({ sessionID: parent.id, metadata })
      yield* sessions.setMetadata({
        sessionID: parent.id,
        metadata: { ...metadata, [RayaChief.requestKey]: "Another request" },
      })
      expect(JSON.parse((yield* get.execute({}, opts)).output).recovery).toBeUndefined()
      yield* sessions.setMetadata({ sessionID: parent.id, metadata })
      yield* goals.edit(parent.id, {
        expectedIntent: selected.intent,
        criteria: [{ id: "research", description: "Verify the research", verification: "Cite authorized results" }],
      })
      const generic = yield* goals.get(parent.id)
      if (!generic) throw new Error("Generic goal required")
      yield* sessions.setMetadata({
        sessionID: parent.id,
        metadata: {
          ...metadata,
          [ChiefVerification.recovery]: { ...proof, goal: { ...proof.goal, intent: generic.intent } },
        },
      })
      const hint = JSON.parse((yield* get.execute({}, opts)).output).recovery
      expect(hint.task_id).toBe(child.id)
      expect(hint.example).toContain("missing authorized work")
      expect(hint.example).not.toContain("final newline")
      expect(hint.example).not.toContain("source and saved target")
      yield* storage.replace(["raya", "goal", parent.id], { ...(yield* goals.get(parent.id)), status: "complete" })
      expect(JSON.parse((yield* get.execute({}, opts)).output).recovery).toBeUndefined()
    }),
  { timeout: 30_000 },
)

it.instance(
  "timer factory requires its own completed goal observation before work",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const plugin = yield* Plugin.Service
      const agents = yield* Agent.Service
      const prompts = yield* SessionPrompt.Service
      const processors = yield* SessionProcessor.Service
      const fs = yield* FSUtil.Service
      const ctx = yield* InstanceState.context
      const agent = yield* agents.get("auto")
      if (!agent) throw new Error("Actual Auto agent required")
      const file = path.join(ctx.directory, "timer.txt")
      yield* fs.writeFileString(file, "ACTUAL_TIMER_FILE")
      const goals = RayaGoal.make({ sessions, storage })
      const factory = Effect.fn(function* (kind: "timer" | "manual", completion?: "reply") {
        const session = yield* sessions.create({
          metadata: {
            rayaRoutine: {
              version: 2,
              agentID: "fixture",
              runID: crypto.randomUUID(),
              scheduleVersion: 1,
              trigger:
                kind === "timer"
                  ? { kind, id: crypto.randomUUID(), scheduledAt: Date.now(), observedAt: Date.now() }
                  : { kind },
            },
          },
          permission: [
            { permission: "*", pattern: "*", action: "deny" },
            ...["get_goal", "update_goal", "read"].map((permission) => ({
              permission,
              pattern: permission === "read" ? file : "*",
              action: "allow" as const,
            })),
            { permission: "read", pattern: path.relative(ctx.worktree, file), action: "allow" },
          ],
        })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          agent: "auto",
          model: { providerID: model.providerID, modelID: model.id },
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: user.id,
          type: "text",
          text: "Read the timer fixture",
        })
        yield* goals.create(
          session.id,
          "Read the timer fixture",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          completion,
        )
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          parentID: user.id,
          role: "assistant",
          agent: "auto",
          mode: "auto",
          cost: 0,
          path: { cwd: ctx.directory, root: ctx.directory },
          providerID: model.providerID,
          modelID: model.id,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        })
        const processor = yield* processors.create({ assistantMessage: assistant, sessionID: session.id, model })
        const resolve = Effect.fn(function* () {
          return yield* SessionTools.resolve({
            agent,
            model,
            session: yield* sessions.get(session.id),
            processor,
            messages: yield* sessions.messages({ sessionID: session.id }),
            bypassAgentCheck: false,
            memoryCache: {},
            promptOps: {
              cancel: prompts.cancel,
              resolvePromptParts: prompts.resolvePromptParts,
              prompt: (input) => prompts.prompt(input).pipe(Effect.orDie),
            },
          })
        })
        const catalog = yield* resolve()
        const call = Effect.fn(function* (name: string, input: Record<string, unknown>, tools = catalog) {
          const execute = tools[name]?.execute
          if (!execute) throw new Error(`Actual ${name} callback required`)
          const value = yield* Effect.promise(
            async () =>
              await execute(input, { toolCallId: name, messages: [], abortSignal: new AbortController().signal }),
          )
          return Schema.decodeUnknownSync(
            Schema.Struct({
              title: Schema.String,
              output: Schema.String,
              metadata: Schema.Record(Schema.String, Schema.Unknown),
            }),
          )(value)
        })
        return { session, user, assistant, call, catalog, resolve }
      })
      const first = yield* factory("timer")
      expect(Object.keys(first.catalog)).toEqual(["get_goal"])
      expect(first.catalog.read).toBeUndefined()
      expect(first.catalog.update_goal).toBeUndefined()
      const prepared = yield* LLMRequestPrep.prepare({
        user: first.user,
        sessionID: first.session.id,
        model,
        agent,
        tools: first.catalog,
        system: [],
        messages: [{ role: "user", content: "Read the timer fixture" }],
        provider: ProviderTest.info({}, model),
        auth: undefined,
        plugin,
        flags: yield* RuntimeFlags.Service,
        isWorkflow: true,
      })
      expect(Object.keys(prepared.tools)).toEqual(["get_goal"])
      const definitions = Object.entries(prepared.tools).map(([name, tool]) => ({
        function: { name, description: tool.description, parameters: { ...asSchema(tool.inputSchema).jsonSchema } },
      }))
      const require = createRequire(import.meta.url)
      const Constructor: new (opts: { strict: boolean }) => { compile(schema: unknown): (input: unknown) => boolean } =
        createRequire(require.resolve("effect/package.json"))("ajv/dist/2020")
      const validate = new Constructor({ strict: false }).compile(ToolEnvelope.schema(definitions, "required"))
      expect(validate({ kind: "tool", name: "get_goal", arguments: {} })).toBe(true)
      expect(validate({ kind: "tool", name: "read", arguments: { filePath: file } })).toBe(false)
      const eligible = yield* agents.get("code")
      if (!eligible) throw new Error("Actual eligible Code agent required")
      const bounded = yield* LLMRequestPrep.prepare({
        user: { ...first.user, agent: "code" },
        sessionID: first.session.id,
        model,
        agent: eligible,
        tools: first.catalog,
        system: ["x ".repeat(model.limit.context * 4)],
        messages: [{ role: "user", content: "Read the timer fixture" }],
        provider: ProviderTest.info({}, model),
        auth: undefined,
        plugin,
        flags: yield* RuntimeFlags.Service,
        isWorkflow: true,
      })
      expect(Object.keys(bounded.tools)).toEqual(["get_goal"])
      expect(bounded.tools.discover_tools).toBeUndefined()
      expect(
        KiloSessionOverflow.measure({
          messages: bounded.system.map((content) => ({ role: "system", content })),
          tools: {},
        }).normalized,
      ).toBeGreaterThan(model.limit.context)
      const envelope = new Constructor({ strict: false }).compile(
        ToolEnvelope.schema(
          Object.entries(bounded.tools).map(([name, tool]) => ({
            function: { name, description: tool.description, parameters: { ...asSchema(tool.inputSchema).jsonSchema } },
          })),
          "required",
        ),
      )
      expect(envelope({ kind: "tool", name: "get_goal", arguments: {} })).toBe(true)
      expect(envelope({ kind: "tool", name: "discover_tools", arguments: {} })).toBe(false)
      expect(
        (yield* sessions.messages({ sessionID: first.session.id }))
          .flatMap((row) => row.parts)
          .some((part) => part.type === "tool"),
      ).toBe(false)
      expect((yield* goals.get(first.session.id))?.status).toBe("active")
      const observed = yield* first.call("get_goal", {})
      expect(observed.title).toBe("Current goal")
      expect(Object.keys(yield* first.resolve())).toEqual(["get_goal"])
      const id = PartID.ascending()
      const publish = (status: "pending" | "completed", metadata = observed.metadata, output = observed.output) =>
        sessions.updatePart({
          id,
          sessionID: first.session.id,
          messageID: first.assistant.id,
          type: "tool",
          tool: "get_goal",
          callID: "get_goal",
          state:
            status === "pending"
              ? { status, input: {}, raw: "" }
              : {
                  status,
                  input: {},
                  title: observed.title,
                  output,
                  metadata,
                  time: { start: Date.now(), end: Date.now() },
                },
        })
      yield* publish("pending")
      expect(Object.keys(yield* first.resolve())).toEqual(["get_goal"])
      yield* publish("completed", {}, observed.output)
      expect(Object.keys(yield* first.resolve())).toEqual(["get_goal"])
      yield* sessions.updatePart({
        id,
        sessionID: first.session.id,
        messageID: first.assistant.id,
        type: "tool",
        tool: "get_goal",
        callID: "get_goal",
        state: {
          status: "error",
          input: {},
          error: "Read refused",
          metadata: observed.metadata,
          time: { start: Date.now(), end: Date.now() },
        },
      })
      expect(Object.keys(yield* first.resolve())).toEqual(["get_goal"])
      const proof = Schema.decodeUnknownSync(
        Schema.Struct({
          version: Schema.Number,
          sessionID: Schema.String,
          messageID: Schema.String,
          revision: Schema.optional(Schema.String),
          digest: Schema.String,
        }),
      )(observed.metadata[GoalGate.key])
      yield* publish("completed", {
        ...observed.metadata,
        [GoalGate.key]: { ...proof, sessionID: "ses_foreign" },
      })
      expect(Object.keys(yield* first.resolve())).toEqual(["get_goal"])
      yield* publish("completed", { ...observed.metadata, [GoalGate.key]: { ...proof, revision: "foreign" } })
      expect(Object.keys(yield* first.resolve())).toEqual(["get_goal"])
      const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ goal: RayaGoal.State })))(
        observed.output,
      )
      yield* publish(
        "completed",
        observed.metadata,
        JSON.stringify({ goal: { ...parsed.goal, objective: "Foreign objective" } }),
      )
      expect(Object.keys(yield* first.resolve())).toEqual(["get_goal"])
      yield* publish("completed")
      const allowed = yield* first.resolve()
      expect(allowed.read).toBeDefined()
      expect(allowed.update_goal).toBeDefined()
      expect((yield* first.call("read", { filePath: file }, allowed)).output).toContain("ACTUAL_TIMER_FILE")
      // Actual turn accounting advances the revision without changing the semantic goal.
      yield* goals.recordTurn(first.session.id, first.assistant.id)
      expect((yield* goals.get(first.session.id))?.revision).not.toBe(parsed.goal.revision)
      expect((yield* first.call("read", { filePath: file }, allowed)).output).toContain("ACTUAL_TIMER_FILE")
      expect((yield* first.call("update_goal", { status: "paused", reason: "Test pause" }, allowed)).title).toBe(
        "Goal paused",
      )
      expect((yield* first.call("read", { filePath: file }, allowed)).title).toBe("Read goal first")
      expect(Object.keys(yield* first.resolve())).toEqual(["get_goal"])
      const second = yield* factory("timer")
      expect(Object.keys(yield* second.resolve())).toEqual(["get_goal"])
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: second.session.id,
        messageID: second.assistant.id,
        type: "tool",
        tool: "get_goal",
        callID: "foreign",
        state: {
          status: "completed",
          input: {},
          title: observed.title,
          output: observed.output,
          metadata: observed.metadata,
          time: { start: Date.now(), end: Date.now() },
        },
      })
      expect(Object.keys(yield* second.resolve())).toEqual(["get_goal"])
      yield* goals.edit(first.session.id, { objective: "Changed current objective" })
      expect((yield* first.call("read", { filePath: file }, allowed)).title).toBe("Read goal first")
      expect(Object.keys(yield* first.resolve())).toEqual(["get_goal"])
      const refreshed = yield* first.call("get_goal", {})
      yield* publish("completed", refreshed.metadata, refreshed.output)
      expect((yield* first.call("read", { filePath: file }, allowed)).output).toContain("ACTUAL_TIMER_FILE")
      yield* sessions.updateMessage({ ...first.user, id: MessageID.ascending(), time: { created: Date.now() } })
      expect((yield* first.call("read", { filePath: file }, allowed)).title).toBe("Read goal first")
      expect(Object.keys(yield* first.resolve())).toEqual(["get_goal"])
      const manual = yield* factory("manual")
      expect((yield* manual.call("read", { filePath: file })).output).toContain("ACTUAL_TIMER_FILE")
      const reply = yield* factory("timer", "reply")
      expect((yield* reply.call("read", { filePath: file })).output).toContain("ACTUAL_TIMER_FILE")
    }),
  { timeout: 30_000 },
)

it.instance("assigned foreground worker catalogs retain files and exclude replacement delegation", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const processors = yield* SessionProcessor.Service
    const prompts = yield* SessionPrompt.Service
    const ctx = yield* InstanceState.context
    const agent = yield* agents.get("general")
    if (!agent) throw new Error("Actual general agent required")
    const parent = yield* sessions.create()
    const child = yield* sessions.create({ parentID: parent.id })
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: child.id,
      role: "user",
      agent: "general",
      model: { providerID: model.providerID, modelID: model.id },
      time: { created: Date.now() },
    })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: child.id,
      parentID: user.id,
      role: "assistant",
      agent: "general",
      mode: "general",
      cost: 0,
      path: { cwd: ctx.directory, root: ctx.directory },
      providerID: model.providerID,
      modelID: model.id,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
    })
    const processor = yield* processors.create({ assistantMessage: assistant, sessionID: child.id, model })
    const resolve = () =>
      Effect.gen(function* () {
        return yield* SessionTools.resolve({
          agent,
          model,
          session: yield* sessions.get(child.id),
          processor,
          messages: yield* sessions.messages({ sessionID: child.id }),
          bypassAgentCheck: false,
          memoryCache: {},
          promptOps: {
            cancel: prompts.cancel,
            resolvePromptParts: prompts.resolvePromptParts,
            prompt: (input) => prompts.prompt(input).pipe(Effect.orDie),
          },
        })
      })
    const legacy = yield* resolve()
    expect(legacy.task).toBeDefined()
    yield* sessions.setMetadata({
      sessionID: child.id,
      metadata: TaskAuthority.assign(TaskAuthority.save({}, "edit"), child.id, parent.id, assistant.id),
    })
    const direct = yield* resolve()
    expect(direct.task).toBeUndefined()
    expect(direct.read).toBeDefined()
    expect(direct.write).toBeDefined()
    expect(["edit", "apply_patch"].filter((id) => id in direct)).toEqual(
      ["edit", "apply_patch"].filter((id) => id in legacy),
    )
    expect(["edit", "apply_patch"].some((id) => id in direct)).toBe(true)
    yield* sessions.setMetadata({
      sessionID: child.id,
      metadata: TaskAuthority.assign({}, child.id, "foreign-parent", assistant.id),
    })
    const invalid = yield* Effect.exit(resolve())
    expect(invalid._tag).toBe("Failure")
  }),
)
