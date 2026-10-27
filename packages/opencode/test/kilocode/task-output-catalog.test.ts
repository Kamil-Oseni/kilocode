import { asSchema } from "ai"
import { TaskSchema } from "@/kilocode/tool/task-schema"
import { expect } from "bun:test"
import path from "node:path"
import { Effect, Exit, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Truncate } from "@/tool/truncate"
import { Permission } from "@/permission"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Storage } from "@/storage/storage"
import { ToolRegistry } from "@/tool/registry"
import { MessageID, PartID } from "@/session/schema"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { continuation, owned } from "@/kilocode/task/continuation"
import * as Admission from "@/kilocode/task/output-admission"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { database, storage } from "./fixtures/effect-profile"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Session.node,
      SessionProcessor.node,
      SessionProjector.node,
      ToolRegistry.node,
      Database.node,
      Storage.node,
      FSUtil.node,
      Plugin.node,
      RuntimeFlags.node,
      Config.node,
      MCP.node,
      Truncate.node,
      Permission.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)

it.instance(
  "actual scoped resolver requires original owner and exposes only mediated builtins",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* Storage.Service
      const db = yield* Database.Service
      const dir = (yield* TestInstance).directory
      const file = path.join(dir, "own.md")
      const other = path.join(dir, "foreign.md")
      const worker = (id: string): RayaTask.Agent => ({
        id,
        name: id,
        role: "generalist",
        objective: "Write own file",
        capabilities: [],
        memoryScope: "project",
        schedule: { kind: "manual" },
        access: "full",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      })
      const sender = worker("sender")
      const recipient = worker("recipient")
      const delegations = RayaTaskDelegation.make(db)
      const admitted = yield* delegations.admit(
        {
          source: "catalog-original",
          senderID: sender.id,
          recipientID: recipient.id,
          objective: "Write own file",
          outputs: [file],
        },
        sender,
        recipient,
      )
      const taken = yield* delegations.take(recipient.id)
      if (!taken?.childRunID) throw new Error("Actual original delegation was not taken")
      const session = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        metadata: {
          rayaRoutine: {
            version: 1,
            agentID: recipient.id,
            runID: taken.childRunID,
            scheduleVersion: 1,
            trigger: { kind: "manual" },
            delegationID: admitted.record.id,
            outputs: [file],
          },
        },
      })
      yield* delegations.attach(taken.id, taken.childRunID, session.id)
      yield* RayaTaskSnapshot.make({ storage: store }).save({
        version: 2,
        runID: taken.childRunID,
        sessionID: session.id,
        agentID: recipient.id,
        at: 1,
        definition: recipient,
        objective: "Write own file",
        outputs: [file],
      })
      expect(Exit.isFailure(yield* Admission.check(session.id, [file]).pipe(Effect.exit))).toBe(true)
      const execution = RayaTaskExecution.make(store)
      const owner = { id: taken.childRunID, agentID: recipient.id, sessionID: session.id }
      // The ordering contract is the explicitly selected local compatible envelope, not OpenAI strict schema.
      const model = ProviderTest.model({ api: { ...ProviderTest.model().api, npm: "@ai-sdk/openai-compatible" } })
      const agents = yield* Agent.Service
      const agent = yield* agents.get("generalist")
      if (!agent) throw new Error("Actual builtin agent is missing")
      const user = MessageID.ascending()
      yield* sessions.updateMessage({
        id: user,
        sessionID: session.id,
        role: "user",
        agent: agent.name,
        model: { providerID: model.providerID, modelID: model.id },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: user,
        type: "text",
        text: "Write own file",
      })
      yield* RayaGoal.make({ storage: store, sessions }).create(session.id, "Write own file", user)
      const message = {
        id: MessageID.ascending(),
        parentID: user,
        sessionID: session.id,
        role: "assistant" as const,
        modelID: model.id,
        providerID: model.providerID,
        mode: agent.name,
        agent: agent.name,
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(message)
      const processor = yield* SessionProcessor.Service
      const handle = yield* processor.create({ assistantMessage: message, sessionID: session.id, model })
      const resolver = SessionTools.resolve({
        agent,
        model,
        session,
        processor: handle,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {
          cancel: () => Effect.die("No cancellation"),
          resolvePromptParts: () => Effect.die("No prompt parsing"),
          prompt: () => Effect.die("No inference"),
        },
        memoryCache: {},
      })
      yield* execution.acquire(owner)
      yield* execution.enter(
        owner,
        Effect.gen(function* () {
          expect(yield* Admission.check(session.id, [file])).toEqual([file])
          expect(Exit.isFailure(yield* Admission.check(session.id, [other]).pipe(Effect.exit))).toBe(true)
          const initial = yield* resolver
          expect(Object.keys(initial)).toEqual(["get_goal"])
          const execute = initial.get_goal.execute
          if (!execute) throw new Error("Actual goal observation executor is missing")
          const observed = yield* Effect.promise(() =>
            Promise.resolve(
              execute(
                {},
                {
                  toolCallId: "original-observation",
                  messages: [],
                  abortSignal: new AbortController().signal,
                },
              ),
            ),
          )
          const output = Schema.decodeUnknownSync(
            Schema.Struct({
              title: Schema.String,
              output: Schema.String,
              metadata: Schema.Record(Schema.String, Schema.Unknown),
            }),
          )(observed)
          yield* handle.completeToolCall("original-observation", output)
          const tools = yield* resolver
          expect(Object.keys(tools)).toContain("read")
          expect(Object.keys(tools)).toContain("write")
          for (const name of ["write", "edit", "apply_patch"])
            if (tools[name])
              expect(asSchema(tools[name].inputSchema).jsonSchema).toMatchObject({
                $comment: "raya:scoped-file-order:v1",
              })
          expect(asSchema(tools.read.inputSchema).jsonSchema).not.toMatchObject({
            $comment: "raya:scoped-file-order:v1",
          })

          for (const name of ["bash", "task", "execute", "webfetch", "lsp", "list_mcp_resources"])
            expect(Object.keys(tools)).not.toContain(name)
          yield* sessions.setMetadata({
            sessionID: session.id,
            metadata: {
              rayaRoutine: {
                version: 1,
                agentID: recipient.id,
                runID: taken.childRunID,
                scheduleVersion: 1,
                trigger: { kind: "manual" },
              },
            },
          })
          expect(Exit.isFailure(yield* Admission.check(session.id, []).pipe(Effect.exit))).toBe(true)
          const stripped = yield* sessions.get(session.id)
          expect(yield* continuation({ database: db, storage: store, session: stripped })).toBe(false)
          yield* sessions.setMetadata({ sessionID: session.id, metadata: session.metadata ?? {} })
        }),
      )
      yield* execution.finish(owner)
      yield* sessions.setMetadata({ sessionID: session.id, metadata: {} })
      expect(Exit.isFailure(yield* Admission.check(session.id, [file]).pipe(Effect.exit))).toBe(true)
      const lost = yield* sessions.get(session.id)
      expect(yield* continuation({ database: db, storage: store, session: lost })).toBe(false)
      const writes: string[] = []
      yield* owned(
        { database: db, storage: store, session: lost },
        Effect.sync(() => writes.push("unexpected")),
      )
      expect(writes).toEqual([])
      const ordinary = yield* sessions.create({ title: "Ordinary unchanged chat" })
      expect(yield* Admission.check(ordinary.id, [other])).toBeUndefined()
      expect(yield* continuation({ database: db, storage: store, session: ordinary })).toBe(true)
      const legacy = { type: "object" as const, properties: { filePath: { type: "string" as const } } }
      expect(yield* TaskSchema.prepare("write", legacy, ordinary.id, message.id, agent.name)).toEqual(legacy)
    }),
  {},
  30_000,
)
