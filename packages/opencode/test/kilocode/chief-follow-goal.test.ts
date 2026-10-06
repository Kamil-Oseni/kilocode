import { asSchema, jsonSchema, tool as aiTool } from "ai"
import { LLMRequestPrep } from "@/session/llm/request"
import { ToolEnvelope } from "@/kilocode/provider/tool-envelope"
import { createRequire } from "node:module"
import { afterEach, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Worktree } from "@/worktree"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Storage } from "@/storage/storage"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Provider } from "@/provider/provider"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RayaChief } from "@/kilocode/chief"
import { ChiefRouteTool } from "@/kilocode/tool/chief-route"
import { ChiefVerification } from "@/kilocode/chief/verification"
import { ChiefRefinement } from "@/kilocode/chief/refinement"
import { Refusal } from "@/kilocode/session/tool-refusal"
import { TaskAuthority } from "@/kilocode/tool/task-authority"
import { Question } from "@/question"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import { ProviderTest } from "../fake/provider"
import { goalTools } from "@/kilocode/tool/goal"
import * as Tool from "@/tool/tool"
import { TaskSchema } from "@/kilocode/tool/task-schema"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const model = ProviderTest.model({ providerID: ref.providerID, id: ref.modelID, variants: { xhigh: {} } })
const auto = ProviderTest.model({ providerID: ProviderV2.ID.make("kilo"), id: ModelV2.ID.make("kilo-auto/small") })
const catalog = {
  [model.providerID]: ProviderTest.info({}, model),
  [auto.providerID]: ProviderTest.info({}, auto),
}
const provider = ProviderTest.fake({
  model,
  list: () => Effect.succeed(catalog),
  getProvider: (id) =>
    catalog[id] ? Effect.succeed(catalog[id]) : Effect.die(new Error(`Unknown test provider: ${id}`)),
  getModel: (providerID, modelID) => {
    const found = catalog[providerID]?.models[modelID]
    return found ? Effect.succeed(found) : Effect.die(new Error(`Unknown test model: ${providerID}/${modelID}`))
  },
  closest: (id) =>
    Effect.succeed(id === auto.providerID ? { providerID: auto.providerID, modelID: auto.id } : undefined),
  getSmallModel: (id) => Effect.succeed(id === auto.providerID ? auto : undefined),
})

const layer = (flags: Partial<RuntimeFlags.Info> = {}, durable = false) =>
  LayerNode.compile(
    LayerNode.group([
      ...(durable ? [Storage.node, FSUtil.node, Git.node, Worktree.node] : []),
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Provider.node,
      Question.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [
      [Provider.node, provider.layer],
      [RuntimeFlags.node, RuntimeFlags.layer(flags)],
      ...(durable ? [[InstanceStore.bootstrapNode, InstanceBootstrap.node] as const] : []),
    ],
  )

const planned = testEffect(layer({}, true))

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

// prettier-ignore
planned.instance("reserves verification for an authenticated Chief follow from goal", () =>
  Effect.gen(function* () {
    for (const mode of [
      "continuation",
      "current",
      "request",
      "user",
      "call",
      "compat",
      "compat-request",
      "compat-user",
      "edit",
      "conflict",
      "readonly",
      "omitted-access",
      "refinement",
      "refinement-resume",
      "refinement-resume-legacy",
      "refinement-resume-forged",
      "refinement-resume-appeared",
      "unknown-resume",
      "refinement-forged",
      "refinement-child",
      "refinement-running",
      "refinement-plan",
      "refinement-user",
      "refinement-call",
      "compaction",
      "compaction-absent",
      "compaction-forged",
      "compaction-failed",
      "compaction-manual",
      "compaction-parent",
      "compaction-newer",
      "compaction-paused",
      "stale-contract",
      "parent-deny",
      "forged",
      "stale-dispatch",
      "changed-intent",
      "foreign-intake",
      "newer-input",
    ] as const) {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const work =
        mode.startsWith("refinement") ||
        [
          "edit",
          "conflict",
          "readonly",
          "omitted-access",
          "refinement",
          "unknown-resume",
          "stale-contract",
          "parent-deny",
        ].includes(mode)
      const request = work ? "Write the requested file" : "Inspect the private fixture and report its actual contents"
      if (work)
        yield* sessions.setPermission({
          sessionID: chat.id,
          permission: [
            { permission: "edit", pattern: "*", action: "deny" },
            ...(mode === "parent-deny"
              ? []
              : [{ permission: "edit", pattern: "/private/result.txt", action: "allow" as const }]),
          ],
        })
      yield* sessions.updateMessage({ ...assistant, agent: "auto", mode: "auto" })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: assistant.parentID,
        type: "text",
        text: request,
      })
      const decision: RayaChief.Pending = {
        ...(work && mode !== "omitted-access" && !mode.startsWith("refinement")
          ? { access: "edit" as const, userID: mode === "stale-contract" ? "foreign-user" : assistant.parentID }
          : {}),
        request,
        agent:
          ["readonly", "omitted-access"].includes(mode) || mode.startsWith("refinement") ? "researcher" : "general",
        role:
          ["readonly", "omitted-access"].includes(mode) || mode.startsWith("refinement") ? "researcher" : "generalist",
        needs_plan: false,
        confidence: 0.9,
        reason: "Inspect the fixture",
        candidates: [
          {
            agent:
              ["readonly", "omitted-access"].includes(mode) || mode.startsWith("refinement") ? "researcher" : "general",
            role:
              ["readonly", "omitted-access"].includes(mode) || mode.startsWith("refinement")
                ? "researcher"
                : "generalist",
            score: 8,
            reason: "Inspect the fixture",
          },
        ],
        prompted: false,
        latency: 0,
        chiefModel: "test/test-model",
      }
      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: {
          [RayaChief.requestKey]: request,
          [RayaChief.phaseKey]: mode.startsWith("compat") || mode.startsWith("refinement") ? "task" : "goal",
          [RayaChief.modelKey]: ref,
          [RayaChief.logKey]: [{ ...decision, model: "test/test-model" }],
          preserved: true,
        },
      })
      if (mode.startsWith("refinement")) {
        const rows = yield* sessions.messages({ sessionID: chat.id })
        const user = rows.find((row) => row.info.id === assistant.parentID)
        if (user?.info.role !== "user") throw new Error("Expected original user")
        yield* sessions.updateMessage({ ...user.info, agent: "auto" })
      }
      const authored = assistant.parentID
      if (
        ["continuation", "forged", "stale-dispatch", "changed-intent", "foreign-intake", "newer-input"].includes(mode)
      ) {
        const storage = yield* Storage.Service
        const goals = RayaGoal.make({ storage, sessions })
        yield* goals.create(chat.id, request)
        const queued = yield* goals.continued(chat.id)
        if (!queued?.dispatch) throw new Error("Expected queued dispatch")
        const active = yield* goals.dispatched(chat.id, queued.dispatch.id)
        if (!active?.dispatch?.messageID) throw new Error("Expected actual dispatch")
        const user = yield* sessions.updateMessage({
          id: mode === "foreign-intake" ? MessageID.ascending() : active.dispatch.messageID,
          sessionID: chat.id,
          role: "user",
          agent: "auto",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: user.id,
          type: "text",
          synthetic: true,
          text: mode === "forged" ? "Untrusted synthetic guidance" : RayaGoalContinuation.expected(request),
        })
        yield* goals.bound(chat.id, active.dispatch.id, "controlled-child")
        assistant.id = MessageID.ascending()
        assistant.parentID = user.id
        yield* sessions.updateMessage({ ...assistant, agent: "auto", mode: "auto" })
        if (mode === "stale-dispatch") yield* goals.control(chat.id, "paused")
        if (mode === "changed-intent") {
          yield* goals.control(chat.id, "paused")
          yield* goals.control(chat.id, "active")
        }
        if (mode === "newer-input") {
          const newer = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: chat.id,
            role: "user",
            agent: "auto",
            model: ref,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: chat.id,
            messageID: newer.id,
            type: "text",
            text: request,
          })
        }
      }
      if (mode.startsWith("compaction")) {
        const storage = yield* Storage.Service
        const goals = RayaGoal.make({ storage, sessions })
        if (mode !== "compaction-absent") yield* goals.create(chat.id, request)
        const marker = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: marker.id,
          sessionID: chat.id,
          type: "compaction",
          auto: mode !== "compaction-manual",
          overflow: false,
        })
        const summary = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          agent: "compaction",
          mode: "compaction",
          summary: true,
          parentID: mode === "compaction-parent" ? authored : marker.id,
          finish: mode === "compaction-failed" ? "length" : "stop",
          time: { created: Date.now(), completed: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: summary.id,
          type: "text",
          text: "Controlled persisted compaction summary",
        })
        const intake = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: intake.id,
          type: "text",
          synthetic: true,
          metadata: { compaction_continue: true },
          text:
            mode === "compaction-forged"
              ? "Forged guidance"
              : "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
        })
        assistant.id = MessageID.ascending()
        assistant.parentID = intake.id
        yield* sessions.updateMessage({ ...assistant, agent: "auto", mode: "auto" })
        if (mode === "compaction-paused") yield* goals.control(chat.id, "paused")
        if (mode === "compaction-newer") {
          const newer = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "auto",
            model: ref,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: chat.id,
            messageID: newer.id,
            type: "text",
            text: request,
          })
        }
      }
      const call = "follow-from-goal"
      const part = {
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: assistant.id,
        type: "tool" as const,
        tool: "task",
        callID: call,
        state: {
          status: "running" as const,
          input: mode.startsWith("refinement")
            ? { access: "edit" }
            : mode === "unknown-resume"
              ? { task_id: SessionID.make("ses_missing_capable_child") }
              : {},
          time: { start: Date.now() },
        },
      }
      yield* sessions.updatePart(part)
      let started = 0
      let failure: "error" | "cancelled" | undefined
      const ops: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (text) => Effect.succeed([{ type: "text" as const, text }]),
        prompt: (input) =>
          Effect.gen(function* () {
            started++
            const user = yield* sessions.updateMessage({
              id: input.messageID!,
              sessionID: input.sessionID,
              role: "user",
              agent: input.agent!,
              model: input.model!,
              time: { created: Date.now() },
            })
            for (const item of input.parts) {
              if (item.type === "text")
                yield* sessions.updatePart({
                  ...item,
                  id: PartID.ascending(),
                  messageID: user.id,
                  sessionID: input.sessionID,
                })
            }
            if (failure === "error") return yield* Effect.die(new Error("Controlled recovery failure"))
            if (failure === "cancelled") return yield* Effect.interrupt
            const result = reply(input, "Inspected the fixture")
            if (result.info.role !== "assistant") throw new Error("Expected assistant")
            yield* sessions.updateMessage({ ...result.info, time: { ...result.info.time, completed: Date.now() } })
            for (const item of result.parts) yield* sessions.updatePart(item)
            return result
          }),
      }
      const def = yield* (yield* TaskTool).init()
      if (
        [
          "current",
          "continuation",
          "compaction",
          "compaction-absent",
          "compaction-forged",
          "compaction-failed",
          "compaction-manual",
          "compaction-parent",
          "compaction-newer",
          "compaction-paused",
          "stale-contract",
          "forged",
          "stale-dispatch",
          "changed-intent",
          "foreign-intake",
          "newer-input",
        ].includes(mode)
      ) {
        if (!def.jsonSchema) throw new Error("Actual Task advertisement required")
        const shape = def.jsonSchema
        if (!shape) throw new Error("Task schema is unavailable")
        const projected = yield* TaskSchema.prepare("task", shape, chat.id, assistant.id, "auto")
        const valid = ["current", "continuation", "compaction", "compaction-absent"].includes(mode)
        expect(projected === def.jsonSchema).toBe(!valid)
        expect(projected.anyOf).toBe(valid ? undefined : def.jsonSchema.anyOf)
        expect(yield* TaskSchema.prepare("task", shape, chat.id, assistant.id, "general")).toBe(def.jsonSchema)
        const foreign = { ...def.jsonSchema }
        expect(yield* TaskSchema.prepare("task", foreign, chat.id, assistant.id, "auto")).toBe(foreign)
      }
      const before = (yield* sessions.children(chat.id)).length
      const result = yield* Effect.exit(
        def.execute(
          {
            subagent_type:
              ["readonly", "omitted-access"].includes(mode) || mode.startsWith("refinement") ? "researcher" : "general",
            brief: { objective: work ? "Write the requested file" : "Inspect the fixture" },
            ...(mode === "unknown-resume" ? { task_id: SessionID.make("ses_missing_capable_child") } : {}),
            ...(mode === "conflict"
              ? { access: "read" as const }
              : mode === "omitted-access" || mode.startsWith("refinement")
                ? { access: "edit" as const }
                : {}),
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            callID: mode.startsWith("compat") ? undefined : mode === "call" ? "foreign-call" : call,
            agent: "auto",
            abort: new AbortController().signal,
            extra: { promptOps: ops },
            messages: [],
            ask: () =>
              Effect.gen(function* () {
                if (mode === "request" || mode === "compat-request")
                  yield* sessions.setMetadata({
                    sessionID: chat.id,
                    metadata: {
                      ...(yield* sessions.get(chat.id)).metadata,
                      [RayaChief.requestKey]: "A changed request",
                    },
                  })
                if (mode === "user" || mode === "compat-user") {
                  const user = yield* sessions.updateMessage({
                    id: MessageID.ascending(),
                    sessionID: chat.id,
                    role: "user",
                    agent: "auto",
                    model: ref,
                    time: { created: Date.now() },
                  })
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    sessionID: chat.id,
                    messageID: user.id,
                    type: "text",
                    text: request,
                  })
                }
              }).pipe(Effect.orDie),
            metadata: (input) =>
              sessions.updatePart({ ...part, state: { ...part.state, metadata: input.metadata } }).pipe(Effect.asVoid),
          },
        ),
      )
      if (mode === "unknown-resume") {
        expect(Exit.isFailure(result)).toBe(true)
        if (!Exit.isFailure(result)) throw new Error("Expected missing resume refusal")
        const error = Cause.squash(result.cause)
        expect(error).toBeInstanceOf(Refusal)
        if (!(error instanceof Refusal)) throw error
        expect(error.reason).toBe("task-resume")
        expect((yield* sessions.children(chat.id)).length).toBe(before)
        expect(started).toBe(0)
        expect((yield* sessions.get(chat.id)).metadata?.["raya.chief.access-refusals"]).toBeUndefined()
        continue
      }
      if (mode.startsWith("refinement")) {
        expect(Exit.isFailure(result)).toBe(true)
        if (!Exit.isFailure(result)) throw new Error("Expected capability refusal")
        expect(Cause.squash(result.cause)).toBeInstanceOf(Refusal)
        expect((yield* sessions.children(chat.id)).length).toBe(before)
        yield* sessions.updatePart({
          ...part,
          state: {
            ...part.state,
            status: "error",
            error:
              mode === "refinement-resume-legacy"
                ? "The selected specialist cannot perform the requested work class"
                : Refusal.access,
            time: { start: Date.now(), end: Date.now() },
          },
        })
        if (mode.startsWith("refinement-resume")) {
          const input = { access: "edit" as const, task_id: SessionID.make("ses_missing_refinement_child") }
          const missing = { ...part, id: PartID.ascending(), callID: "missing-resume", state: { ...part.state, input } }
          yield* sessions.updatePart(missing)
          const rejected = yield* Effect.exit(
            def.execute(
              { ...input, brief: { objective: request }, subagent_type: "researcher" },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                callID: missing.callID,
                agent: "auto",
                abort: new AbortController().signal,
                messages: [],
                extra: { promptOps: ops },
                ask: () => Effect.void,
                metadata: () => Effect.void,
              },
            ),
          )
          expect(Exit.isFailure(rejected)).toBe(true)
          if (!Exit.isFailure(rejected)) throw new Error("Expected missing resume refusal")
          expect(Cause.squash(rejected.cause)).toBeInstanceOf(Refusal)
          expect((yield* sessions.children(chat.id)).length).toBe(before)
          expect(started).toBe(0)
          yield* sessions.updatePart({
            ...missing,
            state: {
              ...missing.state,
              status: "error",
              error: Refusal.resume,
              time: { start: Date.now(), end: Date.now() },
            },
          })
        }
        const route = {
          ...part,
          id: PartID.ascending(),
          tool: "chief_route",
          callID: "refine-route",
          state: {
            status: "running" as const,
            input: { access: "edit", objective: request },
            time: { start: Date.now() },
          },
        }
        yield* sessions.updatePart(route)
        const ctx = {
          sessionID: chat.id,
          messageID: assistant.id,
          callID: route.callID,
          agent: "auto",
          abort: new AbortController().signal,
          messages: [],
          extra: {},
          ask: () => Effect.void,
          metadata: () => Effect.void,
        }
        if (mode === "refinement-resume-appeared") {
          yield* (yield* Database.Service).db.insert(SessionTable).values({
            id: SessionID.make("ses_missing_refinement_child"),
            project_id: chat.projectID,
            slug: "appeared-resume",
            directory: AbsolutePath.make(chat.directory),
            title: "Foreign existing session",
            version: "test",
            time_created: Date.now(),
            time_updated: Date.now(),
          })
        }
        if (mode === "refinement-resume-forged") {
          const saved = yield* sessions.get(chat.id)
          const proofs = saved.metadata?.["raya.chief.access-refusals"]
          if (!Array.isArray(proofs)) throw new Error("Expected actual refusal proofs")
          yield* sessions.setMetadata({
            sessionID: chat.id,
            metadata: { ...saved.metadata, "raya.chief.access-refusals": proofs.filter((proof) => !proof.resumeID) },
          })
        }
        if (mode === "refinement-forged") {
          const saved = yield* sessions.get(chat.id)
          const metadata = Object.fromEntries(
            Object.entries(saved.metadata ?? {}).filter(([key]) => key !== "raya.chief.access-refusals"),
          )
          yield* sessions.setMetadata({ sessionID: chat.id, metadata })
        }
        if (mode === "refinement-child") yield* sessions.create({ parentID: chat.id })
        if (mode === "refinement-running")
          yield* sessions.updatePart({ ...part, id: PartID.ascending(), callID: "unknown-task" })
        if (mode === "refinement-plan")
          yield* sessions.updatePart({ ...route, id: PartID.ascending(), tool: "chief_plan", callID: "saved-plan" })
        if (mode === "refinement-user") {
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: chat.id,
            role: "user",
            agent: "auto",
            model: ref,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: chat.id,
            type: "text",
            text: request,
          })
        }
        if (mode === "refinement-call") ctx.callID = "foreign-route"
        const definition = yield* (yield* ChiefRouteTool).init()
        if (!["refinement", "refinement-resume", "refinement-resume-legacy"].includes(mode)) {
          const refused = yield* Effect.exit(definition.execute({ access: "edit", objective: request }, ctx))
          expect(Exit.isFailure(refused)).toBe(true)
          expect(RayaChief.history((yield* sessions.get(chat.id)).metadata)).toHaveLength(1)
          expect(started).toBe(0)
          expect((yield* sessions.children(chat.id)).length).toBe(mode === "refinement-child" ? before + 1 : before)
          continue
        }
        const captured = ChiefRefinement.fingerprint((yield* sessions.get(chat.id)).metadata)
        const routes = yield* Effect.all(
          [
            definition.execute({ access: "edit", objective: "ignored rewrite" }, ctx),
            definition.execute({ access: "edit", objective: "another ignored rewrite" }, ctx),
          ],
          { concurrency: "unbounded" },
        )
        expect(routes.filter((value) => value.title === "Auto already routed")).toHaveLength(1)
        const routed = routes.find((value) => value.title !== "Auto already routed")
        if (!routed) throw new Error("Expected one refined routing decision")
        const updated = yield* sessions.get(chat.id)
        expect(routed.metadata.decision?.access).toBe("edit")
        expect(routed.metadata.decision?.request).toBe(request)
        expect(RayaChief.history(updated.metadata)).toHaveLength(2)
        expect(updated.metadata?.[ChiefRefinement.key]).toMatchObject({ access: "edit", userID: authored })
        expect((yield* sessions.children(chat.id)).length).toBe(before)
        const retry = {
          ...part,
          id: PartID.ascending(),
          callID: "refined-task",
          state: {
            ...part.state,
            input: { access: "edit", brief: { objective: request } },
            status: "running" as const,
          },
        }
        yield* sessions.updatePart(retry)
        const stale = yield* Effect.exit(
          ChiefVerification.reserve({
            sessions,
            storage: yield* Storage.Service,
            sessionID: chat.id,
            messageID: assistant.id,
            callID: retry.callID,
            request,
            userID: authored,
            contract: captured,
          }),
        )
        expect(Exit.isFailure(stale)).toBe(true)
        expect(RayaChief.phase((yield* sessions.get(chat.id)).metadata)).toBe("task")
        expect((yield* sessions.children(chat.id)).length).toBe(before)
        const completed = yield* def.execute(
          { access: "edit", brief: { objective: request } },
          {
            ...ctx,
            callID: retry.callID,
            extra: { promptOps: ops },
            metadata: (value) =>
              sessions
                .updatePart({ ...retry, state: { ...retry.state, metadata: value.metadata } })
                .pipe(Effect.asVoid),
          },
        )
        expect(completed.metadata.selectedAgent).toBe(routed.metadata.decision?.agent)
        expect(started).toBe(1)
        const child = yield* sessions.get(completed.metadata.sessionId)
        expect(TaskAuthority.hard(child.metadata, "edit", ["/private/result.txt"])).toEqual([])
        expect(TaskAuthority.hard(child.metadata, "edit", ["/private/other.txt"])).toHaveLength(1)
        continue
      }
      const parent = yield* sessions.get(chat.id)
      if (
        mode !== "current" &&
        mode !== "compat" &&
        mode !== "edit" &&
        mode !== "continuation" &&
        mode !== "compaction" &&
        mode !== "compaction-absent"
      ) {
        if (!Exit.isFailure(result)) throw new Error(`Expected refusal for ${mode}`)
        expect(Exit.isFailure(result)).toBe(true)
        expect(started).toBe(0)
        expect((yield* sessions.children(chat.id)).length).toBe(before)
        expect(RayaChief.phase(parent.metadata)).toBe(
          mode.startsWith("compat") || mode.startsWith("refinement") ? "task" : "goal",
        )
        expect(parent.metadata?.["raya.chief.verification"]).toBeUndefined()
        continue
      }
      if (Exit.isFailure(result)) throw Cause.squash(result.cause)
      expect(result.value.metadata.selectedAgent).toBe("general")
      if (mode === "edit") {
        const child = yield* sessions.get(result.value.metadata.sessionId)
        expect(child.metadata?.["raya.task.authority"]).toMatchObject({ access: "edit" })
        expect(TaskAuthority.direct(child.metadata, child.id, child.parentID)).toBe(true)
        expect(child.permission).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
        expect(() => TaskAuthority.direct(child.metadata, child.id, "foreign-parent")).toThrow()
        expect(() => TaskAuthority.direct(child.metadata, "foreign-child", child.parentID)).toThrow()
        expect(() => TaskAuthority.direct({ ...child.metadata, "raya.task.execution": { version: 2 } }, child.id, child.parentID)).toThrow()
        expect(TaskAuthority.direct(undefined, child.id, child.parentID)).toBe(false)
        expect(TaskAuthority.hard(child.metadata, "edit", ["/private/result.txt"])).toEqual([])
        for (const prompt of ["Write the requested file", "Repair the same assigned output and verify it"]) {
          const nested = yield* sessions.updateMessage({
            ...assistant, id: MessageID.ascending(), sessionID: child.id,
            parentID: MessageID.ascending(), agent: "general", mode: "general",
          })
          const denied = yield* Effect.exit(def.execute({ subagent_type: "general", prompt, access: "edit" }, {
            sessionID: child.id, messageID: nested.id, callID: "nested-direct-work", agent: "general",
            abort: new AbortController().signal, extra: { promptOps: ops }, messages: [],
            metadata: () => Effect.void, ask: () => Effect.void,
          }))
          expect(Exit.isFailure(denied)).toBe(true)
          expect(yield* sessions.children(child.id)).toHaveLength(0)
          expect(started).toBe(1)
        }
        expect(TaskAuthority.hard(child.metadata, "edit", ["/private/other.txt"])).toEqual([
          { permission: "edit", pattern: "/private/other.txt", action: "deny" },
        ])
      }
      expect(started).toBe(1)
      if (mode === "compat") {
        expect(RayaChief.phase(parent.metadata)).toBe("verify")
        expect(parent.metadata?.["raya.chief.verification"]).toBeUndefined()
        continue
      }
      expect(RayaChief.phase(parent.metadata)).toBe(["continuation", "compaction"].includes(mode) ? "goal" : "done")
      expect(parent.metadata?.preserved).toBe(true)
      expect(parent.metadata?.["raya.chief.verification"]).toMatchObject({
        kind: "foreground",
        callID: call,
        userID: authored,
        child: { sessionID: result.value.metadata.sessionId },
      })
      if (["continuation", "compaction"].includes(mode)) {
        const id = result.value.metadata.sessionId
        const decode = (text: string) => {
          const raw = text.match(/<task_recovery>([^\n]+)<\/task_recovery>/)?.[1]
          if (!raw) throw new Error("Task did not expose a structured recovery call")
          return Schema.decodeUnknownSync(Schema.Struct({
            kind: Schema.Literal("tool"), name: Schema.Literal("task"),
            arguments: Schema.Struct({task_id: SessionID, prompt: Schema.String}),
          }))(JSON.parse(raw))
        }
        const handoff = decode(result.value.output)
        expect(handoff.arguments.task_id).toBe(id)
        expect(handoff.arguments.prompt.trim().length).toBeGreaterThan(0)
        const count = (yield* sessions.children(chat.id)).length
        const attempt = Effect.fn(function* (input: Parameters<typeof def.execute>[0], message = assistant, publication = Effect.void) {
          const retry = {...part,messageID:message.id,id:PartID.ascending(),callID:`recovery-${PartID.ascending()}`,
            state:{status:"running" as const,input,time:{start:Date.now()}},
          }
          yield* sessions.updatePart(retry)
          return yield* def.execute(input, {
            sessionID: chat.id, messageID: message.id, callID: retry.callID, agent: "auto",
            abort: new AbortController().signal, messages: [], extra: { promptOps: ops },
            ask: () => publication,
            metadata: (value) => sessions.updatePart({...retry,state:{...retry.state,metadata:value.metadata}}).pipe(Effect.asVoid),
          })
        })
        for (const input of [
          { brief: { objective: "Inspect the fixture again" } },
          { description: "A completely reworded label", prompt: "Recover the same assigned work" },
          { task_id: SessionID.make("ses_wrong_recovery_child"), prompt: "Continue the same work" },
        ]) {
          const refused = yield* Effect.exit(attempt(input))
          if (!Exit.isFailure(refused)) throw new Error("Expected retained-worker refusal")
          const error = Cause.squash(refused.cause)
          expect(error).toBeInstanceOf(Refusal)
          if (!(error instanceof Refusal)) throw error
          expect(error.reason).toBe("task-recovery")
          expect(error.message).toContain(`task_id="${id}"`)
          expect(decode(error.message)).toEqual(handoff)
          expect((yield* sessions.children(chat.id)).length).toBe(count)
          expect(started).toBe(1)
        }
        const common = {
          storage: yield* Storage.Service, sessions, background: yield* BackgroundJob.Service,
          sessionID: chat.id, messageID: assistant.id, agent: "auto", planned: false,
        }
        const require = createRequire(import.meta.url)
        const Constructor: new (options: { strict: boolean }) => { compile(schema: unknown): (value: unknown) => boolean } = createRequire(require.resolve("effect/package.json"))("ajv/dist/2020")
        const validator = new Constructor({ strict: false })
        const shape = def.jsonSchema
        if (!shape) throw new Error("Task schema is unavailable")
        const projected = yield* TaskSchema.prepare("task", shape, chat.id, assistant.id, "auto")
        const valid = validator.compile(projected)
        expect(valid({background:false})).toBe(false)
        expect(valid({task_id:id})).toBe(true)
        expect(valid({task_id:"ses_foreign",prompt:"Repair missing work"})).toBe(false)
        expect(valid({branch_id:"saved-branch"})).toBe(true)
        expect(yield* ChiefVerification.reuse({...common, taskID: id})).toBe(true)
        // A real rejected completion audit, not an arbitrary worker narrative, requires corrective context.
        const updater = yield* goalTools(RayaGoal.make({storage:common.storage,sessions}),sessions).update.pipe(Effect.flatMap(Tool.init))
        const completion = {status:"complete" as const,summary:"Worker claimed completion",requirements:[]}
        const rejection = Effect.gen(function* () {
          const audit = yield* updater.execute(completion, {sessionID:chat.id,messageID:assistant.id,callID:"recovery-audit",agent:"auto",abort:new AbortController().signal,messages:[],ask:()=>Effect.void,metadata:()=>Effect.void})
          expect(audit.title).toBe("Completion audit rejected")
          expect(audit.output).toContain("A rejected audit is not a request for user approval")
          expect(audit.output).toContain("fresh eligibleEvidence callIDs")
          expect(audit.output).toContain("same retained worker")
          expect(audit.output).toContain("A real permission refusal or explicitly required human review")
          yield* sessions.updatePart({id:PartID.ascending(),sessionID:chat.id,messageID:assistant.id,
            type:"tool",tool:"update_goal",callID:"recovery-audit",state:{status:"completed",input:completion,
              title:audit.title,output:audit.output,metadata:audit.metadata,time:{start:Date.now(),end:Date.now()}},
          })
        })
        // The preflight permits an ordinary ID-only resume; a rejection during permission refresh
        // must be observed by locked admission before any child dispatch.
        const late = yield* Effect.exit(attempt({task_id:id}, assistant, rejection))
        if (!Exit.isFailure(late)) throw new Error("Late rejection bypassed locked correction admission")
        const error = Cause.squash(late.cause)
        expect(error).toBeInstanceOf(Refusal)
        if (!(error instanceof Refusal)) throw error
        expect(error.reason).toBe("task-objective")
        expect(started).toBe(1)
        expect((yield* sessions.children(chat.id)).length).toBe(count)
        // Static execution decoding must enforce correction even without the advertised schema.
        for (const input of [
          { task_id: id },
          { task_id: id, prompt: "" },
          { task_id: id, prompt: " \t\n " },
          { task_id: id, prompt: " ", brief: { objective: "\t" } },
        ]) {
          const refused = yield* Effect.exit(attempt(input))
          if (!Exit.isFailure(refused)) throw new Error("Blank correction resumed the retained worker")
          const error = Cause.squash(refused.cause)
          expect(error).toBeInstanceOf(Refusal)
          if (!(error instanceof Refusal)) throw error
          expect(error.reason).toBe("task-objective")
          expect(error.message).toContain(`task_id="${id}"`)
          expect((yield* sessions.children(chat.id)).length).toBe(count)
          expect(started).toBe(1)
        }
        expect(yield* ChiefVerification.reuse({...common, taskID: id, prompt: "Correct the saved result"})).toBe(true)
        expect(yield* ChiefVerification.reuse({...common, taskID: id, objective: "Correct the saved result"})).toBe(true)
        const corrected = yield* TaskSchema.prepare("task", shape, chat.id, assistant.id, "auto")
        const correction = validator.compile(corrected)
        expect(correction({task_id:id,background:false})).toBe(false)
        expect(correction({task_id:id,prompt:"   "})).toBe(false)
        expect(correction({task_id:id,prompt:"Perform the missing write then read the saved file"})).toBe(true)
        expect(correction({task_id:id,brief:{objective:"Correct missing work and verify it"}})).toBe(true)
        expect(correction({branch_id:"saved-branch"})).toBe(true)
        expect(corrected.description).toContain("summary is not verified file evidence")
        const description = TaskSchema.description("Keep the original Task instructions", corrected)
        expect(description).toContain("Keep the original Task instructions")
        expect(TaskSchema.description("Unrelated tool", shape)).toBe("Unrelated tool")
        const authored = (yield* sessions.messages({sessionID:chat.id})).find(row=>row.info.role==="user")?.info
        if (authored?.role !== "user") throw new Error("Current authored input required")
        const native = yield* LLMRequestPrep.prepare({
          user:authored,
          sessionID:chat.id, model, agent:{name:"auto",mode:"primary",options:{},permission:[]},
          system:[],messages:[{role:"user",content:"Correct missing work"}],
          tools:{task:aiTool({description,inputSchema:jsonSchema(corrected),execute:async()=>"ok"})},
          provider:catalog[model.providerID],auth:undefined,
          plugin:{init:()=>Effect.void,trigger:(_name,_input,output)=>Effect.succeed(output),list:()=>Effect.succeed([])},
          flags:yield* RuntimeFlags.Service,isWorkflow:false,
        })
        const final = asSchema(native.tools.task.inputSchema).jsonSchema
        expect(native.tools.task.description).toContain("Keep the original Task instructions")
        expect(native.tools.task.description).toContain(`task_id="${id}"`)
        expect(native.tools.task.description).toContain("supply a concrete correction objective")
        expect(validator.compile(final)({task_id:id})).toBe(false)
        const definitions = [{function:{name:"task",description:native.tools.task.description,parameters:{...final}}}]
        expect(ToolEnvelope.guide(definitions)).toContain("supply a concrete correction objective")
        expect(ToolEnvelope.guide(definitions)).toContain(id)
        const envelope = validator.compile(ToolEnvelope.schema(definitions,"required"))
        expect(envelope({kind:"tool",name:"task",arguments:{task_id:id}})).toBe(false)
        expect(envelope({kind:"tool",name:"task",arguments:{task_id:id,prompt:"Perform missing write and actual readback"}})).toBe(true)

        // A real foreign session cannot stand in for the captured foreground worker.
        const foreign = yield* sessions.create({ title: "Foreign recovery target" })
        const observation = yield* Schema.decodeUnknownEffect(ChiefVerification.Observation)(parent.metadata?.[ChiefVerification.key])
        yield* sessions.setMetadata({sessionID: chat.id, metadata: {...parent.metadata,
          [ChiefVerification.recovery]: {...observation, child: {...observation.child!, sessionID: foreign.id}},
        }})
        const rejected = yield* Effect.exit(attempt({prompt: "Recover", task_id: foreign.id}))
        expect(Exit.isFailure(rejected)).toBe(true)
        expect((yield* sessions.children(chat.id)).length).toBe(count)
        expect(started).toBe(1)
        yield* sessions.setMetadata({sessionID: chat.id, metadata: parent.metadata!})
        // Synthesis updates presentation evidence without erasing the authenticated worker.
        const goals = RayaGoal.make({storage: common.storage, sessions})
        expect((yield* goals.get(chat.id))?.status).toBe("active")
        const synthesis = {...part,id:PartID.ascending(),callID:"recover-synthesis",tool:"chief_synthesize",
          state:{status:"running" as const,input:{},time:{start:Date.now()}},
        }
        yield* sessions.updatePart(synthesis)
        yield* ChiefVerification.synthesis({...common,callID:synthesis.callID,request,goals})
        expect((yield* sessions.get(chat.id)).metadata?.[ChiefVerification.key]).toMatchObject({kind:"synthesis"})
        const bypass = yield* Effect.exit(attempt({prompt:"Start another worker after synthesis"}))
        if (!Exit.isFailure(bypass)) throw new Error("Synthesis erased the recovery fence")
        expect(Cause.squash(bypass.cause)).toBeInstanceOf(Refusal)
        expect((yield* sessions.children(chat.id)).length).toBe(count)
        expect(started).toBe(1)
        // Saved branch admission is owned by ChiefTaskBinding, not the unplanned recovery fence.
        yield* ChiefVerification.reuse({...common, planned: true})
        yield* ChiefVerification.reuse({...common, agent: "build"})
        const resumed = yield* attempt(handoff.arguments)
        expect(resumed.metadata.sessionId).toBe(id)
        const retained = yield* sessions.get(id)
        expect(TaskAuthority.direct(retained.metadata, retained.id, retained.parentID)).toBe(true)
        expect(retained.permission).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
        expect((yield* sessions.children(chat.id)).length).toBe(count)
        expect(started).toBe(2)
        for (const status of ["error", "cancelled"] as const) {
          failure = status
          const failed = yield* Effect.exit(attempt({task_id:id,prompt:"Recover the same worker"}))
          expect(Exit.isFailure(failed)).toBe(true)
          expect((yield* common.background.get(id))?.status).toBe(status)
          const replacement = yield* Effect.exit(attempt({prompt:"Replace after failed recovery"}))
          if (!Exit.isFailure(replacement)) throw new Error("Failed resume admitted a replacement")
          expect(Cause.squash(replacement.cause)).toBeInstanceOf(Refusal)
          failure = undefined
          const recovered = yield* attempt({task_id:id,prompt:"Repair the failed recovery"})
          expect(recovered.metadata.sessionId).toBe(id)
          expect((yield* sessions.children(chat.id)).length).toBe(count)
        }
        expect(started).toBe(6)
        if (mode === "continuation") {
          // Complete the real parent dispatch, then create a later durable dispatch for the same request/intent.
          const current = yield* sessions.messages({sessionID:chat.id})
          for (const row of current) for (const value of row.parts) {
            if (value.type !== "tool" || value.state.status !== "running") continue
            yield* sessions.updatePart({...value,state:{status:"completed",input:value.state.input,
              output:"Controlled turn settled",title:"Settled",metadata:value.state.metadata??{},
              time:{start:value.state.time.start,end:Date.now()}},
            })
          }
          yield* sessions.updateMessage({...assistant,finish:"stop",time:{...assistant.time,completed:Date.now()}})
          const settled = yield* goals.finished(chat.id, assistant.id, "completed")
          expect(settled?.dispatch?.phase).toBe("finished")
          const queued = yield* goals.continued(chat.id)
          if (!queued?.dispatch) throw new Error("Expected later queued dispatch")
          const active = yield* goals.dispatched(chat.id,queued.dispatch.id)
          if (!active?.dispatch?.messageID) throw new Error("Expected later admitted dispatch")
          const intake = yield* sessions.updateMessage({id:active.dispatch.messageID,sessionID:chat.id,
            role:"user",agent:"auto",model:ref,time:{created:Date.now()},
          })
          yield* sessions.updatePart({id:PartID.ascending(),messageID:intake.id,sessionID:chat.id,
            type:"text",synthetic:true,text:RayaGoalContinuation.expected(request),
          })
          const bound = yield* goals.bound(chat.id,active.dispatch.id,"later-controlled-worker")
          expect(bound?.dispatch?.worker).toBe("later-controlled-worker")
          expect(bound?.inputs).toContain(intake.id)
          if (!bound) throw new Error("Later dispatch was not admitted")
          const saved = (yield* sessions.messages({sessionID:chat.id})).find((row)=>row.info.id === intake.id)
          if (!saved) throw new Error("Missing actual later intake")
          expect(RayaGoalContinuation.matches(saved,chat.id,intake.id,bound)).toBe(true)
          const later = {...assistant,id:MessageID.ascending(),parentID:intake.id,time:{created:Date.now()}}
          yield* sessions.updateMessage(later)
          const next = yield* Effect.exit(attempt({prompt:"Repeat the same work in a later dispatch"},later))
          expect(Exit.isFailure(next)).toBe(true)
          expect((yield* sessions.children(chat.id)).length).toBe(count)
          expect(started).toBe(6)
        }
        // A genuine new authored request is not deduplicated against old completed work.
        const user = yield* sessions.updateMessage({id: MessageID.ascending(),role: "user",sessionID:chat.id,
          agent: "auto",model:ref,time:{created:Date.now()},
        })
        yield* sessions.updatePart({id:PartID.ascending(),sessionID:chat.id,messageID:user.id,type:"text",text:"Inspect a distinct new request"})
        const fresh = {...assistant,id:MessageID.ascending(),parentID:user.id,agent:"auto",mode:"auto"}
        yield* sessions.updateMessage(fresh)
        yield* sessions.setMetadata({sessionID:chat.id,metadata:{...(yield* sessions.get(chat.id)).metadata,
          [RayaChief.requestKey]:"Inspect a distinct new request",[RayaChief.phaseKey]:"task",
        }})
        const stale = yield* Effect.exit(ChiefVerification.reuse(common))
        expect(Exit.isFailure(stale)).toBe(true)
        expect((yield* sessions.children(chat.id)).length).toBe(count)
        yield* ChiefVerification.reuse({...common,messageID:fresh.id})
        yield* sessions.setMetadata({sessionID:chat.id,metadata:{...(yield* sessions.get(chat.id)).metadata,
          [RayaChief.phaseKey]:"route",
        }})
        const route = {...part,messageID:fresh.id,id:PartID.ascending(),callID:"fresh-recovery-route",tool:"chief_route",
          state:{status:"running" as const,input:{access:"read"},time:{start:Date.now()}},
        }
        yield* sessions.updatePart(route)
        const router = yield* (yield* ChiefRouteTool).init()
        yield* router.execute({access:"read",objective:"Inspect a distinct new request"},{
          sessionID:chat.id,messageID:fresh.id,callID:route.callID,agent:"auto",abort:new AbortController().signal,
          messages:[],metadata:()=>Effect.void,ask:()=>Effect.void,
        })
        const publication = Effect.gen(function* () {
          const latest = yield* sessions.updateMessage({id:MessageID.ascending(),role:"user",sessionID:chat.id,
            agent:"auto",model:ref,time:{created:Date.now()},
          })
          yield* sessions.updatePart({id:PartID.ascending(),sessionID:chat.id,messageID:latest.id,
            type:"text",text:"A newer authored request published during task permission admission",
          })
          yield* sessions.setMetadata({sessionID:chat.id,metadata:{...(yield* sessions.get(chat.id)).metadata,
            [RayaChief.requestKey]:"A newer authored request published during task permission admission",
          }})
        })
        const raced = yield* Effect.exit(attempt({prompt:"Inspect the new request",access:"read"},fresh,publication))
        expect(Exit.isFailure(raced)).toBe(true)
        expect(RayaChief.request((yield* sessions.get(chat.id)).metadata)).toBe("A newer authored request published during task permission admission")
        expect((yield* sessions.children(chat.id)).length).toBe(count)
        expect(started).toBe(6)
      }
    }
  }),
  30_000,
)
