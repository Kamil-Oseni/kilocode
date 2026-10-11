import { expect } from "bun:test"
import { asSchema, streamText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createRequire } from "node:module"
import path from "node:path"
import { writeFile } from "node:fs/promises"
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
import * as TaskSchema from "@/kilocode/tool/task-schema"
import { ReadTool } from "@/tool/read"
import * as Artifact from "@/kilocode/goal/artifact"
import { RayaChief } from "@/kilocode/chief"
import { ChiefVerification } from "@/kilocode/chief/verification"
import { RayaGoal } from "@/kilocode/goal"
import { goalTools } from "@/kilocode/tool/goal"
import * as GoalGate from "@/kilocode/goal/tool-gate"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import { KiloToolSchema } from "@/kilocode/session/tool-schema"
import { ToolEnvelope } from "@/kilocode/provider/tool-envelope"
import { context, schemas } from "@/kilocode/provider/ollama-context"
import { localFetch } from "@/kilocode/provider/local-scheduler"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { database, storage } from "./fixtures/effect-profile"

const model = ProviderTest.model({ limit: { context: 32768, output: 1024 } })
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
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
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
      const inspection = yield* sessions.updateMessage(assistant())
      const inspector = yield* goalTools(goals, sessions).get.pipe(Effect.flatMap(Tool.init))
      const preview = yield* inspector.execute(
        {},
        {
          sessionID: parent.id,
          messageID: inspection.id,
          callID: "inspect-existing-work",
          agent: "auto",
          abort: new AbortController().signal,
          messages: [],
          ask: () => Effect.void,
          metadata: () => Effect.void,
        },
      )
      const available = JSON.parse(preview.output)
      expect(available.recovery).toBeUndefined()
      expect(available.verification).toContain("Inspect the actual eligibleEvidence tools")
      expect(available.verification).toContain("Eligible receipts alone do not prove completion")
      expect(available.verification).toContain("LF (\\n) and CRLF (\\r\\n) are different bytes, including on Windows")
      expect(available.verification).toContain("original goal objective")
      expect(available.verification).toContain("after a completed get_goal inspection")
      expect(available.verification).toContain("Correct citations alone never require another Task")
      expect(available.eligibleEvidence.map((row: { callID: string }) => row.callID)).toContain("read-0")
      expect(available.eligibleEvidence.map((row: { callID: string }) => row.callID)).toContain("read-1")
      expect((yield* goals.get(parent.id))?.status).toBe("active")
      const original = yield* goals.get(parent.id)
      const criteria = original?.criteria
      if (!original?.intent || !criteria) throw new Error("Original verification criteria missing")
      yield* goals.edit(parent.id, {
        expectedIntent: original.intent,
        criteria: [{ id: "verified", description: "Verify the delegated result", verification: "Actual file read" }],
      })
      const audit = yield* sessions.updateMessage(assistant())
      const update = yield* goalTools(goals, sessions).update.pipe(Effect.flatMap(Tool.init))
      const rejected = yield* update.execute(
        {
          status: "complete",
          requirements: [
            {
              criterionID: "verified",
              requirement: "Verify the delegated result",
              passed: true,
              evidence: [{ callID: call, summary: "Worker reported completion" }],
            },
          ],
        },
        {
          sessionID: parent.id,
          messageID: audit.id,
          callID: "citation-audit",
          agent: "auto",
          abort: new AbortController().signal,
          messages: [],
          ask: () => Effect.void,
          metadata: () => Effect.void,
        },
      )
      expect(rejected.title).toBe("Completion audit rejected")
      expect(rejected.output).toContain("Delegation result")
      expect(rejected.output).toContain("audit_correction")
      expect(rejected.output).toContain('"callID":"read-0"')
      expect(rejected.output).toContain('"callID":"read-1"')
      expect(rejected.output).toContain("Do not rerun a Task merely to repair citations")
      expect(rejected.output).not.toContain("<task_recovery>")
      expect((yield* goals.get(parent.id))?.status).toBe("active")
      expect((yield* goals.get(parent.id))?.auditAttempt?.accepted).toBe(false)
      const getter = yield* goalTools(goals, sessions).get.pipe(Effect.flatMap(Tool.init))
      const inspected = yield* getter.execute(
        {},
        {
          sessionID: parent.id,
          messageID: audit.id,
          callID: "citation-menu",
          agent: "auto",
          abort: new AbortController().signal,
          messages: [],
          ask: () => Effect.void,
          metadata: () => Effect.void,
        },
      )
      const menu = JSON.parse(inspected.output)
      expect(menu.recovery).toBeUndefined()
      expect(menu.audit_correction).toContain("Do not rerun a Task merely to repair citations")
      expect(menu.eligibleEvidence.map((row: { callID: string }) => row.callID)).toContain("read-0")
      expect(menu.eligibleEvidence.map((row: { callID: string }) => row.callID)).toContain("read-1")
      const revised = yield* goals.get(parent.id)
      if (!revised?.intent) throw new Error("Current verification criteria missing")
      yield* goals.edit(parent.id, { expectedIntent: revised.intent, criteria })
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
      const sanitized = yield* Effect.promise(() => KiloToolSchema.sanitize(prepared.tools))
      const parameters = yield* Effect.promise(() => Promise.resolve(asSchema(sanitized.task.inputSchema).jsonSchema))
      expect(parameters.required).toContain("task_id")
      expect(parameters.properties?.task_id).toEqual({ type: "string", enum: [child.id] })
      expect(parameters.anyOf).toHaveLength(2)
      for (const branch of parameters.anyOf ?? []) {
        if (typeof branch !== "object") throw new Error("Complete recovery object alternative required")
        expect(branch.type).toBe("object")
        expect(branch.required).toContain("task_id")
        expect(branch.properties?.task_id).toEqual({ type: "string", enum: [child.id] })
      }
      const report = process.env.RAYA_RECOVERY_SCHEMA_REPORT
      if (report)
        yield* Effect.promise(() => writeFile(report, JSON.stringify({ parameters }, null, 2) + "\n", { flag: "wx" }))
      expect(prepared.tools.update_goal).toBeDefined()
      const options = context(
        {
          localInference: true,
          localInferenceAPI: "ollama",
          localInferenceToolFormat: "completion-envelope-v1",
          localInferenceContext: 32768,
        },
        model,
        sanitized,
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
      const wire = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const rows: unknown[] = []
          const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              expect(new URL(request.url).pathname).toBe("/api/chat")
              const body = Schema.decodeUnknownSync(Schema.Struct({ format: Schema.Unknown }))(await request.json())
              rows.push(body.format)
              return new Response(
                [
                  {
                    model: model.api.id,
                    message: { role: "assistant", content: JSON.stringify(handoff) },
                    done: false,
                  },
                  { model: model.api.id, done: true, done_reason: "stop", prompt_eval_count: 8, eval_count: 3 },
                ]
                  .map((row) => JSON.stringify(row))
                  .join("\n") + "\n",
                { headers: { "content-type": "application/x-ndjson" } },
              )
            },
          })
          return { server, rows }
        }),
        ({ server, rows }) =>
          Effect.promise(async () => {
            // Match the SDK transport's production context: no per-request native schema snapshot.
            const sdk = createOpenAICompatible({
              name: "synthetic-recovery-wire",
              baseURL: `${server.url}v1`,
              fetch: Object.assign(
                localFetch(
                  context(
                    {
                      localInference: true,
                      localInferenceAPI: "ollama",
                      localInferenceToolFormat: "completion-envelope-v1",
                      localInferenceContext: 32768,
                    },
                    model,
                  ),
                ),
                { preconnect: globalThis.fetch.preconnect },
              ),
            })
            const result = streamText({
              model: sdk.chatModel(model.api.id),
              messages: [{ role: "user", content: "Synthetic recovery transport; no model inference." }],
              tools: { task: { description: sanitized.task.description, inputSchema: sanitized.task.inputSchema } },
              toolChoice: "required",
              maxOutputTokens: 1024,
              maxRetries: 0,
            })
            const calls = []
            for await (const event of result.fullStream) {
              if (event.type === "error") throw event.error
              if (event.type === "tool-call") calls.push(event)
            }
            expect(calls).toHaveLength(1)
            expect(calls[0]).toMatchObject({ toolName: "task", input: handoff.arguments })
            expect(rows).toHaveLength(1)
            return validator.compile(rows[0])
          }),
        ({ server }) => Effect.promise(() => server.stop(true)),
      )
      for (const input of [
        { brief: { objective: "Perform the missing write" } },
        { task_id: child.id },
        { task_id: "ses_foreign", prompt: "Correct the saved work" },
        { branch_id: "unsaved-branch", prompt: "Create replacement work" },
        { branch_id: "unsaved-branch", task_id: "ses_foreign", prompt: "Replace the retained worker" },
      ]) {
        expect(validate(input)).toBe(false)
        expect(local(input)).toBe(false)
        expect(envelope({ kind: "tool", name: "task", arguments: input })).toBe(false)
        expect(wire({ kind: "tool", name: "task", arguments: input })).toBe(false)
      }
      const correction = { task_id: child.id, brief: { objective: "Perform missing write and read the saved file" } }
      expect(validate(correction)).toBe(true)
      expect(local(correction)).toBe(true)
      expect(envelope({ kind: "tool", name: "task", arguments: correction })).toBe(true)
      expect(wire({ kind: "tool", name: "task", arguments: correction })).toBe(true)
      expect(prepared.tools.task.description).toContain(raw)
      expect(validate(handoff.arguments)).toBe(true)
      expect(local(handoff.arguments)).toBe(true)
      expect(envelope(handoff)).toBe(true)
      expect(wire(handoff)).toBe(true)
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
      const held = yield* ChiefVerification.retained({
        sessions,
        storage,
        background: jobs,
        sessionID: parent.id,
        messageID: current.id,
        agent: "auto",
        planned: false,
      })
      expect(held && held.taskID).toBe(child.id)
      yield* fs.writeFileString(outputfile, "a".repeat(48))
      const capture = yield* reader.execute(
        { filePath: outputfile },
        {
          ...opts,
          sessionID: child.id,
          messageID: terminal.id,
          callID: "read-guidance",
          agent: "code",
        },
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: child.id,
        messageID: terminal.id,
        type: "tool",
        tool: "read",
        callID: "read-guidance",
        state: {
          status: "completed",
          input: { filePath: outputfile },
          title: capture.title,
          output: capture.output,
          metadata: capture.metadata,
          time: { start: Date.now(), end: Date.now() },
        },
      })
      const paired = yield* update.execute(
        {
          ...input,
          requirements: [
            {
              ...input.requirements[0],
              evidence: [{ callID: "read-guidance", summary: "Target only" }],
            },
          ],
        },
        opts,
      )
      expect(paired.title).toBe("Completion audit rejected")
      expect(paired.output).toContain('"audit_correction"')
      expect(paired.output).not.toContain("<task_recovery>")
      const grouped = JSON.parse((yield* get.execute({}, opts)).output)
      expect(grouped.recovery).toBeUndefined()
      expect(grouped.criterionEvidence[0].evidence.map((row: { callID: string }) => row.callID)).toEqual([
        "read-0",
        "read-guidance",
      ])
      expect((yield* goals.get(parent.id))?.status).toBe("active")
      expect(yield* sessions.children(parent.id)).toHaveLength(1)
      yield* fs.writeFileString(outputfile, "a".repeat(48) + "\n")
      const changed = JSON.parse((yield* get.execute({}, opts)).output)
      expect(changed.criterionEvidence).toEqual([])
      expect(changed.recovery.task_id).toBe(child.id)
      expect(changed.recovery.example).toContain("final newline")
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
      const hint = JSON.parse((yield* get.execute({}, opts)).output)
      expect(hint.recovery).toBeUndefined()
      expect(hint.verification).toContain("Inspect the actual eligibleEvidence tools")
      expect(hint.verification).toContain("Eligible receipts alone do not prove completion")
      expect(hint.verification).toContain("concrete missing or stale work identified by inspection")
      expect(hint.eligibleEvidence.length).toBeGreaterThan(0)
      expect((yield* goals.get(parent.id))?.status).toBe("active")
      const retained = {
        sessions,
        storage,
        background: jobs,
        sessionID: parent.id,
        messageID: current.id,
        agent: "auto",
        planned: false,
      }
      expect(yield* ChiefVerification.retained(retained)).not.toBe(false)
      const stale = { ...retained, messageID: MessageID.ascending() }
      expect((yield* ChiefVerification.retained(stale).pipe(Effect.exit))._tag).toBe("Failure")
      const other = yield* sessions.updateMessage({ ...assistant(), agent: "code" })
      expect((yield* ChiefVerification.retained({ ...retained, messageID: other.id }).pipe(Effect.exit))._tag).toBe(
        "Failure",
      )
      const saved = (yield* sessions.get(parent.id)).metadata
      const fresh = TaskSchema.objective({ type: "object", properties: { task_id: { type: "string" } } })
      for (const phase of ["task", "route"] as const) {
        yield* sessions.setMetadata({ sessionID: parent.id, metadata: { ...saved, [RayaChief.phaseKey]: phase } })
        expect((yield* ChiefVerification.retained(stale).pipe(Effect.exit))._tag).toBe("Failure")
        const advertised = yield* TaskSchema.prepare("task", fresh, parent.id, current.id, "auto")
        expect(advertised.properties?.task_id).toEqual({ type: "string" })
        expect(advertised.required?.includes("task_id")).not.toBe(true)
      }
      yield* sessions.setMetadata({ sessionID: parent.id, metadata: { ...saved, [RayaChief.phaseKey]: "done" } })
      expect(yield* ChiefVerification.retained(stale)).toBe(false)
      yield* sessions.setMetadata({ sessionID: parent.id, metadata: { ...saved, [RayaChief.phaseKey]: "goal" } })
      yield* goals.edit(parent.id, {
        expectedIntent: generic.intent,
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
      yield* fs.writeFileString(outputfile, "a".repeat(48))
      const captured = yield* reader.execute(
        { filePath: outputfile },
        {
          ...opts,
          sessionID: child.id,
          messageID: terminal.id,
          callID: "read-corrected",
          agent: "code",
        },
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: child.id,
        messageID: terminal.id,
        type: "tool",
        tool: "read",
        callID: "read-corrected",
        state: {
          status: "completed",
          input: { filePath: outputfile },
          output: captured.output,
          title: captured.title,
          metadata: captured.metadata,
          time: { start: Date.now(), end: Date.now() },
        },
      })
      const accepted = yield* goals.update(parent.id, {
        status: "complete",
        summary: "Verified corrected raw files",
        requirements: [
          {
            criterionID: "bytes",
            requirement: "Preserve the exact source bytes",
            passed: true,
            evidence: [
              { callID: "read-0", sessionID: child.id, messageID: terminal.id, summary: "Actual source Read" },
              {
                callID: "read-corrected",
                sessionID: child.id,
                messageID: terminal.id,
                summary: "Actual corrected target Read",
              },
            ],
          },
        ],
      })
      expect(accepted.status).toBe("complete")
      expect(accepted.audit?.requirements).toHaveLength(1)
      expect(yield* ChiefVerification.retained(stale)).toBe(false)
      const schema = TaskSchema.objective({ type: "object", properties: { task_id: { type: "string" } } })
      expect(yield* TaskSchema.prepare("task", schema, parent.id, stale.messageID, "auto")).toBe(schema)
      expect(JSON.parse((yield* get.execute({}, opts)).output).recovery).toBeUndefined()
      expect((yield* goals.get(parent.id))?.status).toBe("complete")
    }),
  { timeout: 30_000 },
)

it.instance(
  "timer and manual factories require their own completed goal observation before work",
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
      expect(Object.keys(manual.catalog)).toEqual(["get_goal"])
      expect(manual.catalog.read).toBeUndefined()
      expect(manual.catalog.update_goal).toBeUndefined()
      const inspected = yield* manual.call("get_goal", {})
      expect(Object.keys(yield* manual.resolve())).toEqual(["get_goal"])
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: manual.session.id,
        messageID: manual.assistant.id,
        type: "tool",
        tool: "get_goal",
        callID: "manual-goal",
        state: {
          status: "completed",
          input: {},
          title: inspected.title,
          output: inspected.output,
          metadata: inspected.metadata,
          time: { start: Date.now(), end: Date.now() },
        },
      })
      const available = yield* manual.resolve()
      expect(available.read).toBeDefined()
      expect((yield* manual.call("read", { filePath: file }, available)).output).toContain("ACTUAL_TIMER_FILE")
      yield* goals.edit(manual.session.id, { objective: "Review the current manual assignment" })
      expect((yield* manual.call("read", { filePath: file }, available)).title).toBe("Read goal first")
      expect(Object.keys(yield* manual.resolve())).toEqual(["get_goal"])
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
