import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect" // kilocode_change - Cause for resume-hint coverage
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util" // kilocode_change - durable Chief branch test
import { Git } from "@/git" // kilocode_change - durable Chief branch test
import { Worktree } from "@/worktree" // kilocode_change - real Chief edit worktree test
import { InstanceState } from "@/effect/instance-state" // kilocode_change - verify child prompt directory
import { InstanceStore } from "@/project/instance-store" // kilocode_change - worktree bootstrap layer
import { InstanceBootstrap } from "@/project/bootstrap" // kilocode_change - real worktree setup
import path from "node:path" // kilocode_change - verify real child edit destination
import { unlink } from "node:fs/promises" // kilocode_change - restore dirty-parent test fixture
import { Storage } from "@/storage/storage" // kilocode_change - durable Chief branch test
import { ChiefBranches } from "@/kilocode/chief/branches" // kilocode_change - durable Chief branch test
import { RayaGoal } from "@/kilocode/goal" // kilocode_change - durable Chief branch test
import * as GoalChildren from "@/kilocode/goal/children" // kilocode_change - rejected branch releases its child lease
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2" // kilocode_change
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema" // kilocode_change - SessionID used by cost propagation tests
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Provider } from "../../src/provider/provider" // kilocode_change
import { KiloSession } from "../../src/kilocode/session" // kilocode_change
import { KiloTask } from "../../src/kilocode/tool/task" // kilocode_change // raya_change
import { TaskAuthority } from "../../src/kilocode/tool/task-authority" // kilocode_change - raya_change
import { Permission } from "../../src/permission" // kilocode_change - raya_change
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RayaChief } from "../../src/kilocode/chief" // kilocode_change // raya_change - Milestone B
import { ChiefRouteTool } from "../../src/kilocode/tool/chief-route" // kilocode_change // raya_change - Milestone B
import { Question } from "../../src/question" // kilocode_change // raya_change - Milestone B option prompt
import { ProviderTest } from "../fake/provider" // kilocode_change - keep task integration independent of the remote model catalog

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// kilocode_change start - keep task integration independent of the remote model catalog
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
// kilocode_change end

const layer = (
  flags: Partial<RuntimeFlags.Info> = {},
  durable = false, // kilocode_change - optional durable branch fixtures
) =>
  LayerNode.compile(
    LayerNode.group([
      ...(durable ? [Storage.node, FSUtil.node, Git.node, Worktree.node] : []), // kilocode_change - real branch worktrees
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
      Provider.node, // kilocode_change
      Question.node, // kilocode_change // raya_change - Milestone B Chief option prompt
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    // kilocode_change start - the prompt path is stubbed; use its matching in-process model
    [
      [Provider.node, provider.layer],
      [RuntimeFlags.node, RuntimeFlags.layer(flags)],
      ...(durable ? [[InstanceStore.bootstrapNode, InstanceBootstrap.node] as const] : []), // kilocode_change
    ],
    // kilocode_change end
  )

const it = testEffect(layer())
const background = it // kilocode_change - background subagents are enabled by default
const disabled = testEffect(layer({ experimentalBackgroundSubagents: false })) // kilocode_change

const planned = testEffect(layer({}, true)) // kilocode_change - saved Auto Chief branch admission
// kilocode_change start - remove only this test's durable records
const clean = (storage: Storage.Interface, id: SessionID) =>
  Effect.addFinalizer(() =>
    Effect.all([storage.remove(["raya", "goal", id]), storage.remove(["raya", "chief", "branches", id])]).pipe(
      Effect.ignore,
    ),
  )
// kilocode_change end

// kilocode_change start - a saved branch, rather than the caller's task fields, owns its child execution
describe("tool.task planned Auto Chief branch", () => {
  // kilocode_change start - edit authority must move both the saved session and actual prompt into Git isolation
  planned.instance(
    "runs an editing specialist in its reserved worktree without changing the parent",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const git = yield* Git.Service
        const worktrees = yield* Worktree.Service
        const parent = yield* InstanceState.directory
        const { chat, assistant } = yield* seed()
        yield* clean(storage, chat.id)
        const goals = RayaGoal.make({ storage, sessions })
        const goal = yield* goals.create(chat.id, "Edit a child-only file", assistant.parentID)
        if (!goal.intent) throw new Error("expected goal intent")
        yield* goals.initial(chat.id, goal.intent, "auto")
        const ledger = ChiefBranches.make(storage)
        yield* ledger.start({
          goalID: chat.id,
          goalCreatedAt: goal.createdAt,
          requestID: assistant.parentID,
          branches: [
            {
              id: "edit",
              name: "File editor",
              specialist: "designer",
              access: "edit",
              brief: { objective: "Write a child-only file", constraints: [], expectedReturn: "Edited file" },
            },
            {
              id: "audit",
              name: "Read-only audit",
              specialist: "researcher",
              access: "read",
              brief: { objective: "Review independent context", constraints: [], expectedReturn: "Audit" },
            },
          ],
        })
        yield* sessions.setMetadata({
          sessionID: chat.id,
          metadata: { [RayaChief.requestKey]: "Edit a child-only file", [RayaChief.phaseKey]: "task" },
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ctx = {
          sessionID: chat.id,
          messageID: assistant.id,
          callID: "call-edit",
          agent: "auto",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input: SessionPrompt.PromptInput) =>
                Effect.gen(function* () {
                  const dir = yield* InstanceState.directory
                  yield* Effect.promise(() => Bun.write(path.join(dir, "chief-owned.txt"), "written by child"))
                  return reply(input, "Edited child-only file")
                }),
            },
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const dirty = path.join(parent, "uncommitted.txt")
        yield* Effect.promise(() => Bun.write(dirty, "parent draft"))
        expect(
          Exit.isFailure(yield* def.execute({ description: "File editor", branch_id: "edit" }, ctx).pipe(Effect.exit)),
        ).toBe(true)
        expect((yield* ledger.read(chat.id))?.branches[0].worktree).toBeUndefined()
        yield* Effect.promise(() => unlink(dirty))
        const result = yield* def.execute({ description: "File editor", branch_id: "edit" }, ctx)
        const saved = (yield* ledger.read(chat.id))?.branches[0]
        expect(saved?.worktree?.phase).toBe("ready")
        expect(saved?.worktree?.baseCommit).toMatch(/^[0-9a-f]{40}$/)
        const dir = saved?.worktree?.directory
        if (!dir) throw new Error("missing child worktree")
        expect((yield* sessions.get(result.metadata.sessionId)).directory).toBe(dir)
        expect((yield* git.run(["rev-parse", "HEAD"], { cwd: dir })).text().trim()).toBe(saved?.worktree?.baseCommit)
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "chief-owned.txt")).text())).toBe("written by child")
        expect(yield* Effect.promise(() => Bun.file(path.join(parent, "chief-owned.txt")).exists())).toBe(false)
        expect(yield* worktrees.remove({ directory: dir })).toBe(true)
      }),
    { git: true },
    30_000,
  )
  // kilocode_change end

  planned.instance(
    "runs a goal-bound two-branch plan through Auto's registered tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const agents = yield* Agent.Service
        const registry = yield* ToolRegistry.Service
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        yield* clean(storage, chat.id)
        const request = "Audit authorization and navigation"
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.parentID,
          sessionID: chat.id,
          type: "text",
          text: request,
        })
        const goals = RayaGoal.make({ storage, sessions })
        const goal = yield* goals.create(chat.id, request, assistant.parentID)
        if (!goal.intent) throw new Error("expected goal intent")
        yield* goals.initial(chat.id, goal.intent, "auto")
        yield* sessions.setMetadata({
          sessionID: chat.id,
          metadata: { [RayaChief.requestKey]: request, [RayaChief.phaseKey]: "task" },
        })
        const auto = yield* agents.get("auto")
        if (!auto) throw new Error("Auto agent unavailable")
        const tools = yield* registry.tools({ ...ref, agent: auto })
        const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
        const ops: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) =>
            input.sessionID === chat.id
              ? Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
              : Effect.gen(function* () {
                  if (!input.messageID) throw new Error("Missing admitted child message")
                  yield* sessions.updateMessage({
                    id: input.messageID,
                    role: "user",
                    sessionID: input.sessionID,
                    agent: input.agent ?? "general",
                    model: ref,
                    time: { created: Date.now() },
                  })
                  const tool = reply(input, "tool evidence")
                  yield* sessions.updateMessage({ ...tool.info, time: { ...tool.info.time, completed: Date.now() } })
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    sessionID: input.sessionID,
                    messageID: tool.info.id,
                    type: "tool",
                    callID: "call-read",
                    tool: "read",
                    state: {
                      status: "completed",
                      input: {},
                      output: "Read saved state",
                      title: "Read evidence",
                      metadata: {},
                      time: { start: Date.now(), end: Date.now() },
                    },
                  })
                  const result = reply(input, "Saved state inspected and findings confirmed.")
                  yield* sessions.updateMessage({
                    ...result.info,
                    time: { ...result.info.time, completed: Date.now() },
                  })
                  yield* Effect.forEach(result.parts, (part) => sessions.updatePart(part))
                  return result
                }),
        }
        const get = (id: string) => {
          const tool = tools.find((item) => item.id === id)
          if (!tool) throw new Error(`Missing ${id} from Auto registry`)
          return tool
        }
        const context = (callID: string) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          callID,
          agent: "auto",
          abort: new AbortController().signal,
          extra: { promptOps: ops },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        const plan = yield* get("chief_plan").execute(
          {
            proposals: [
              {
                id: "safety",
                name: "Safety audit",
                specialist: "researcher",
                access: "read",
                brief: { objective: "Audit authorization", constraints: [], expectedReturn: "Safety findings" },
                scope: ["authorization"],
                dependsOn: [],
                independence: "Uses saved authorization state.",
                authority: "Read access is sufficient.",
              },
              {
                id: "design",
                name: "Navigation audit",
                specialist: "designer",
                access: "read",
                brief: { objective: "Audit navigation", constraints: [], expectedReturn: "Navigation findings" },
                scope: ["navigation"],
                dependsOn: [],
                independence: "Uses saved navigation state.",
                authority: "Read access is sufficient.",
              },
            ],
          },
          context("call-plan"),
        )
        expect(plan.title).toBe("Auto Chief branches planned")
        const task = get("task")
        const first = yield* task.execute(
          { description: "Safety audit", branch_id: "safety", background: true },
          context("call-safety"),
        )
        const second = yield* task.execute(
          { description: "Navigation audit", branch_id: "design", background: true },
          context("call-design"),
        )
        for (const [index, item] of [first, second].entries()) {
          const id = item.metadata.sessionId
          if (typeof id !== "string") throw new Error("Missing child session identity")
          expect((yield* jobs.wait({ id: SessionID.make(id) })).info?.status).toBe("completed")
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: chat.id,
            messageID: assistant.id,
            type: "tool",
            callID: index === 0 ? "call-safety" : "call-design",
            tool: "task",
            state: {
              status: "completed",
              input: {},
              output: item.output,
              title: item.title,
              metadata: item.metadata,
              time: { start: Date.now(), end: Date.now() },
            },
          })
        }
        expect((yield* Deferred.await(injected).pipe(Effect.timeout("3 seconds"))).goalObjective).toBe(request)
        const inspect = yield* get("chief_inspect").execute({}, context("call-inspect"))
        const report = JSON.parse(inspect.output) as {
          branches: {
            id: string
            name: string
            state: string
            report: string
            evidence: { callID: string; messageID: string; partID: string }[]
          }[]
        }
        expect(report.branches.map((item) => [item.name, item.state])).toEqual([
          ["Safety audit", "completed"],
          ["Navigation audit", "completed"],
        ])
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call-inspect",
          tool: "chief_inspect",
          state: {
            status: "completed",
            input: {},
            output: inspect.output,
            title: inspect.title,
            metadata: inspect.metadata,
            time: { start: Date.now(), end: Date.now() },
          },
        })
        for (const item of report.branches) {
          expect(item.report).toContain("findings confirmed")
          expect(item.evidence).toHaveLength(1)
          yield* get("chief_review").execute(
            { branch_id: item.id, assessment: `${item.name} checked its saved state.`, evidence: item.evidence[0] },
            context(`call-review-${item.id}`),
          )
        }
        yield* get("chief_synthesize").execute(
          {
            summary: "Both saved audits were reviewed.",
            findings: report.branches.map((item) => ({ branch_id: item.id, conclusion: item.report })),
          },
          context("call-synthesize"),
        )
        const ledger = ChiefBranches.make(storage, sessions, jobs)
        expect(yield* ledger.completion(chat.id, goal.createdAt)).toBeUndefined()
      }),
    30_000,
  )

  planned.instance(
    "runs the exact saved brief once and refuses missing, changed, or duplicate branch calls",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const { chat, assistant } = yield* seed()
        yield* clean(storage, chat.id)
        const goals = RayaGoal.make({ storage, sessions })
        const goal = yield* goals.create(chat.id, "Review the product", assistant.parentID)
        if (!goal.intent) throw new Error("expected goal intent")
        yield* goals.initial(chat.id, goal.intent, "auto")
        const branches = ChiefBranches.make(storage)
        yield* branches.start({
          goalID: chat.id,
          goalCreatedAt: goal.createdAt,
          requestID: assistant.parentID,
          branches: [
            {
              id: "safety",
              name: "Safety audit",
              specialist: "researcher",
              access: "read",
              brief: { objective: "Audit authorization", constraints: ["Do not edit"], expectedReturn: "Findings" },
            },
            {
              id: "design",
              name: "UX audit",
              specialist: "designer",
              access: "read",
              brief: { objective: "Audit navigation", constraints: ["Do not edit"], expectedReturn: "Findings" },
            },
          ],
        })
        yield* sessions.setMetadata({
          sessionID: chat.id,
          metadata: { [RayaChief.requestKey]: "Review the entire product", [RayaChief.phaseKey]: "task" },
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const seen: SessionPrompt.PromptInput[] = []
        const ctx = {
          sessionID: chat.id,
          messageID: assistant.id,
          callID: "call-safety",
          agent: "auto",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => seen.push(input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const base = { description: "Ignored caller label", branch_id: "safety" }
        const current = yield* goals.get(chat.id)
        if (!current?.dispatch) throw new Error("expected bound user request")
        yield* goals.revise(chat.id, "A changed objective")
        expect(Exit.isFailure(yield* def.execute(base, ctx).pipe(Effect.exit))).toBe(true)
        yield* storage.replace(["raya", "goal", chat.id], current)
        expect(Exit.isFailure(yield* def.execute({ description: "Missing" }, ctx).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* def.execute({ ...base, subagent_type: "designer" }, ctx).pipe(Effect.exit))).toBe(
          true,
        )
        expect(Exit.isFailure(yield* def.execute({ ...base, access: "edit" }, ctx).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* def.execute({ ...base, prompt: "Different task" }, ctx).pipe(Effect.exit))).toBe(
          true,
        )
        expect(seen).toHaveLength(0)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)

        yield* storage.replace(["raya", "goal", chat.id], {
          ...current,
          dispatch: { ...current.dispatch, messageID: MessageID.ascending() },
        })
        const result = yield* def.execute(base, ctx)
        expect(result.metadata.selectedAgent).toBe("researcher")
        expect(seen).toHaveLength(1)
        expect(seen[0]?.agent).toBe("researcher")
        expect(seen[0]?.parts[0]).toMatchObject({ type: "text", text: expect.stringContaining("Audit authorization") })
        expect(seen[0]?.parts[0]).toMatchObject({
          type: "text",
          text: expect.not.stringContaining("Ignored caller label"),
        })
        const branch = (yield* branches.read(chat.id))?.branches.find((item) => item.id === "safety")
        expect(branch).toMatchObject({
          state: "completed",
          callID: "call-safety",
          sessionID: result.metadata.sessionId,
          messageID: seen[0]?.messageID,
        })
        const child = yield* sessions.get(result.metadata.sessionId)
        expect(TaskAuthority.read(child.metadata)).toBe("read")
        expect(RayaChief.phase((yield* sessions.get(chat.id)).metadata)).toBe("task")

        expect(Exit.isFailure(yield* def.execute(base, ctx).pipe(Effect.exit))).toBe(true)
        expect(seen).toHaveLength(1)
        expect(yield* sessions.children(chat.id)).toHaveLength(1)
      }),
    20_000,
  )

  planned.instance(
    "runs two saved read-only branches concurrently with distinct briefs",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        yield* clean(storage, chat.id)
        const goals = RayaGoal.make({ storage, sessions })
        const goal = yield* goals.create(
          chat.id,
          "Review the product",
          assistant.parentID,
          undefined,
          undefined,
          undefined,
          { concurrentChildren: 2 },
        )
        if (!goal.intent) throw new Error("expected goal intent")
        yield* goals.initial(chat.id, goal.intent, "auto")
        const branches = ChiefBranches.make(storage)
        yield* branches.start({
          goalID: chat.id,
          goalCreatedAt: goal.createdAt,
          requestID: assistant.parentID,
          branches: [
            {
              id: "safety",
              name: "Safety audit",
              specialist: "researcher",
              access: "read",
              brief: {
                objective: "Audit authorization",
                constraints: ["Do not edit"],
                expectedReturn: "Safety findings",
              },
            },
            {
              id: "design",
              name: "UX audit",
              specialist: "designer",
              access: "read",
              brief: { objective: "Audit navigation", constraints: ["Do not edit"], expectedReturn: "UX findings" },
            },
          ],
        })
        yield* sessions.setMetadata({
          sessionID: chat.id,
          metadata: { [RayaChief.requestKey]: "Review the entire product", [RayaChief.phaseKey]: "task" },
        })
        const ready = yield* Deferred.make<void>()
        const done = yield* Deferred.make<void>()
        const seen: SessionPrompt.PromptInput[] = []
        const ops: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) => {
            if (input.sessionID === chat.id) return Effect.succeed(reply(input, "injected"))
            return Effect.gen(function* () {
              seen.push(input)
              if (seen.length === 2) yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(done)
              return reply(input, `${input.agent} findings`)
            })
          },
        }
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ctx = (callID: string) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          callID,
          agent: "auto",
          abort: new AbortController().signal,
          extra: { promptOps: ops },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        const safety = yield* def.execute(
          { description: "Safety audit", branch_id: "safety", background: true },
          ctx("call-safety"),
        )
        const design = yield* def.execute(
          { description: "UX audit", branch_id: "design", background: true },
          ctx("call-design"),
        )
        yield* Deferred.await(ready)
        expect(safety.metadata.background).toBe(true)
        expect(design.metadata.background).toBe(true)
        expect(safety.metadata.sessionId).not.toBe(design.metadata.sessionId)
        expect((yield* jobs.get(safety.metadata.sessionId))?.status).toBe("running")
        expect((yield* jobs.get(design.metadata.sessionId))?.status).toBe("running")
        expect(seen.find((item) => item.agent === "researcher")?.parts[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining("Audit authorization"),
        })
        expect(seen.find((item) => item.agent === "designer")?.parts[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining("Audit navigation"),
        })
        for (const result of [safety, design]) {
          expect(TaskAuthority.read((yield* sessions.get(result.metadata.sessionId)).metadata)).toBe("read")
        }
        yield* Deferred.succeed(done, undefined)
        for (const result of [safety, design]) {
          expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.status).toBe("completed")
        }
        expect((yield* branches.read(chat.id))?.branches.map((item) => item.state)).toEqual(["completed", "completed"])
      }),
    20_000,
  )

  planned.instance(
    "keeps a failed background branch separate from its completed sibling",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        yield* clean(storage, chat.id)
        const goals = RayaGoal.make({ storage, sessions })
        const goal = yield* goals.create(
          chat.id,
          "Review the product",
          assistant.parentID,
          undefined,
          undefined,
          undefined,
          { concurrentChildren: 2 },
        )
        if (!goal.intent) throw new Error("expected goal intent")
        yield* goals.initial(chat.id, goal.intent, "auto")
        const branches = ChiefBranches.make(storage)
        yield* branches.start({
          goalID: chat.id,
          goalCreatedAt: goal.createdAt,
          requestID: assistant.parentID,
          branches: [
            {
              id: "safety",
              name: "Safety audit",
              specialist: "researcher",
              access: "read",
              brief: { objective: "Audit authorization", constraints: [], expectedReturn: "Safety findings" },
            },
            {
              id: "design",
              name: "UX audit",
              specialist: "designer",
              access: "read",
              brief: { objective: "Audit navigation", constraints: [], expectedReturn: "UX findings" },
            },
          ],
        })
        yield* sessions.setMetadata({
          sessionID: chat.id,
          metadata: { [RayaChief.requestKey]: "Review the entire product", [RayaChief.phaseKey]: "task" },
        })
        const ready = yield* Deferred.make<void>()
        const done = yield* Deferred.make<void>()
        let started = 0
        const ops: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) => {
            if (input.sessionID === chat.id) return Effect.succeed(reply(input, "injected"))
            return Effect.gen(function* () {
              started += 1
              if (started === 2) yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(done)
              if (input.agent === "designer") {
                const result = reply(input, "partial UX findings")
                if (result.info.role !== "assistant") return result
                return {
                  ...result,
                  info: {
                    ...result.info,
                    error: MessageV2.fromError(new Error("private UX failure"), { providerID: ref.providerID }),
                  },
                }
              }
              return reply(input, "Safety findings")
            })
          },
        }
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ctx = (callID: string) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          callID,
          agent: "auto",
          abort: new AbortController().signal,
          extra: { promptOps: ops },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        const safety = yield* def.execute(
          { description: "Safety audit", branch_id: "safety", background: true },
          ctx("call-safety"),
        )
        const design = yield* def.execute(
          { description: "UX audit", branch_id: "design", background: true },
          ctx("call-design"),
        )
        yield* Deferred.await(ready)
        expect((yield* jobs.get(safety.metadata.sessionId))?.status).toBe("running")
        expect((yield* jobs.get(design.metadata.sessionId))?.status).toBe("running")
        yield* Deferred.succeed(done, undefined)
        expect((yield* jobs.wait({ id: safety.metadata.sessionId })).info?.status).toBe("completed")
        expect((yield* jobs.wait({ id: design.metadata.sessionId })).info?.status).toBe("error")
        expect((yield* branches.read(chat.id))?.branches.map((item) => item.state)).toEqual(["completed", "failed"])
        expect((yield* branches.read(chat.id))?.branches[1]?.review).toBeUndefined()
      }),
    20_000,
  )

  planned.instance(
    "cancels one running Chief branch without replaying or stopping its sibling",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        yield* clean(storage, chat.id)
        const goals = RayaGoal.make({ storage, sessions })
        const goal = yield* goals.create(
          chat.id,
          "Review the product",
          assistant.parentID,
          undefined,
          undefined,
          undefined,
          { concurrentChildren: 2 },
        )
        if (!goal.intent) throw new Error("expected goal intent")
        yield* goals.initial(chat.id, goal.intent, "auto")
        const branches = ChiefBranches.make(storage)
        yield* branches.start({
          goalID: chat.id,
          goalCreatedAt: goal.createdAt,
          requestID: assistant.parentID,
          branches: [
            {
              id: "safety",
              name: "Safety audit",
              specialist: "researcher",
              access: "read",
              brief: { objective: "Audit authorization", constraints: [], expectedReturn: "Safety findings" },
            },
            {
              id: "design",
              name: "UX audit",
              specialist: "designer",
              access: "read",
              brief: { objective: "Audit navigation", constraints: [], expectedReturn: "UX findings" },
            },
          ],
        })
        yield* sessions.setMetadata({
          sessionID: chat.id,
          metadata: { [RayaChief.requestKey]: "Review the entire product", [RayaChief.phaseKey]: "task" },
        })
        const ready = yield* Deferred.make<void>()
        const done = yield* Deferred.make<void>()
        let started = 0
        const ops: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) => {
            if (input.sessionID === chat.id) return Effect.succeed(reply(input, "injected"))
            return Effect.gen(function* () {
              started += 1
              if (started === 2) yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(done)
              return reply(input, `${input.agent} findings`)
            })
          },
        }
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ctx = (callID: string) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          callID,
          agent: "auto",
          abort: new AbortController().signal,
          extra: { promptOps: ops },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        const safety = yield* def.execute(
          { description: "Safety audit", branch_id: "safety", background: true },
          ctx("call-safety"),
        )
        const design = yield* def.execute(
          { description: "UX audit", branch_id: "design", background: true },
          ctx("call-design"),
        )
        yield* Deferred.await(ready)
        const selected = yield* jobs.get(design.metadata.sessionId)
        if (!selected?.revision) throw new Error("expected a running design job revision")
        expect(selected.status).toBe("running")
        expect((yield* jobs.cancel(design.metadata.sessionId, selected.revision))?.status).toBe("cancelled")
        expect((yield* branches.read(chat.id))?.branches.map((item) => item.state)).toEqual(["admitted", "cancelled"])
        yield* Deferred.succeed(done, undefined)
        expect((yield* jobs.wait({ id: safety.metadata.sessionId })).info?.status).toBe("completed")
        expect((yield* branches.read(chat.id))?.branches.map((item) => item.state)).toEqual(["completed", "cancelled"])
        expect(
          Exit.isFailure(
            yield* def.execute({ description: "UX audit", branch_id: "design" }, ctx("retry")).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(started).toBe(2)
      }),
    20_000,
  )

  planned.instance(
    "removes an unadmitted child when admission loses a race",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const { chat, assistant } = yield* seed()
        yield* clean(storage, chat.id)
        const goals = RayaGoal.make({ storage, sessions })
        const goal = yield* goals.create(
          chat.id,
          "Review the product",
          assistant.parentID,
          undefined,
          undefined,
          undefined,
          { concurrentChildren: 1 },
        )
        if (!goal.intent) throw new Error("expected goal intent")
        yield* goals.initial(chat.id, goal.intent, "auto")
        const branches = ChiefBranches.make(storage)
        yield* branches.start({
          goalID: chat.id,
          goalCreatedAt: goal.createdAt,
          requestID: assistant.parentID,
          branches: [
            {
              id: "safety",
              name: "Safety audit",
              specialist: "researcher",
              access: "read",
              brief: { objective: "Audit authorization", constraints: [], expectedReturn: "Findings" },
            },
            {
              id: "design",
              name: "UX audit",
              specialist: "designer",
              access: "read",
              brief: { objective: "Audit navigation", constraints: [], expectedReturn: "Findings" },
            },
          ],
        })
        yield* sessions.setMetadata({
          sessionID: chat.id,
          metadata: { [RayaChief.requestKey]: "Review the entire product", [RayaChief.phaseKey]: "task" },
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let prompts = 0
        const exit = yield* def
          .execute(
            { description: "Safety audit", branch_id: "safety" },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              callID: "call-safety",
              agent: "auto",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps({ onPrompt: () => prompts++ }) },
              messages: [],
              metadata: () => Effect.void,
              ask: () =>
                branches
                  .admit({
                    goalID: chat.id,
                    goalCreatedAt: goal.createdAt,
                    branchID: "safety",
                    callID: "competing-call",
                    sessionID: SessionID.make(`ses_competing_${crypto.randomUUID()}`),
                    access: "read",
                  })
                  .pipe(Effect.asVoid, Effect.orDie),
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(prompts).toBe(0)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
        expect((yield* branches.read(chat.id))?.branches[0]?.callID).toBe("competing-call")
        const children = yield* GoalChildren.make({ storage, sessions })
        const lease = yield* children.claim(chat.id)
        yield* lease.release
      }),
    20_000,
  )
})
// kilocode_change end

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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

// kilocode_change start - stub signature + prompt body extended to persist assistant cost for propagation tests
function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  sessions?: Session.Interface
  childCost?: number
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        opts?.onPrompt?.(input)
        const rep = reply(input, opts?.text ?? "done")
        if (opts?.sessions && opts?.childCost != null) {
          yield* opts.sessions.updateMessage({ ...rep.info, cost: opts.childCost })
        }
        return rep
      }),
  }
}
// kilocode_change end

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

describe("tool.task", () => {
  // kilocode_change start - raya_change: delegated audits retain a durable authority ceiling
  it.instance(
    "keeps a read-only child below a fully capable specialist after resume",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ctx = {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const created = yield* def.execute(
          {
            description: "Audit permissions",
            prompt: "Inspect authority rules",
            subagent_type: "explore",
            access: "read",
          },
          ctx,
        )
        const child = yield* sessions.get(created.metadata.sessionId)
        expect(TaskAuthority.read(child.metadata)).toBe("read")
        expect(TaskAuthority.read(JSON.parse(JSON.stringify(child.metadata)))).toBe("read")
        expect(() => TaskAuthority.read({ [TaskAuthority.key]: { access: "edit" } })).toThrow(
          "Invalid child authority record",
        )
        const specialist = yield* (yield* Agent.Service).get("explore")
        const effective = Permission.merge(specialist.permission, child.permission ?? [])
        for (const permission of ["edit", "write", "apply_patch", "bash", "notebook_execute", "agent_manager"]) {
          expect(Permission.evaluate(permission, "*", effective).action).toBe("deny")
          expect(TaskAuthority.permits("read", permission, "*")).toBe(false)
        }
        expect(Permission.evaluate("read", "*", effective).action).toBe("allow")

        yield* def.execute(
          {
            description: "Continue audit",
            prompt: "Inspect the remaining policy",
            subagent_type: "explore",
            task_id: child.id,
          },
          ctx,
        )
        const resumed = yield* sessions.get(child.id)
        expect(TaskAuthority.read(resumed.metadata)).toBe("read")
        expect(
          Permission.evaluate("bash", "*", Permission.merge(specialist.permission, resumed.permission ?? [])).action,
        ).toBe("deny")

        const widened = yield* Effect.exit(
          def.execute(
            {
              description: "Widen audit",
              prompt: "Try editing",
              subagent_type: "explore",
              task_id: child.id,
              access: "edit",
            },
            ctx,
          ),
        )
        expect(Exit.isFailure(widened)).toBe(true)
        expect(TaskAuthority.read((yield* sessions.get(child.id)).metadata)).toBe("read")

        yield* sessions.setPermission({
          sessionID: chat.id,
          permission: [{ permission: "read", pattern: "*", action: "deny" }],
        })
        const restricted = yield* def.execute(
          {
            description: "Audit restricted",
            prompt: "Inspect permitted files",
            subagent_type: "explore",
            access: "read",
          },
          ctx,
        )
        const limited = yield* sessions.get(restricted.metadata.sessionId)
        const inherited = Permission.merge(specialist.permission, limited.permission ?? [])
        expect(Permission.evaluate("read", "*", inherited).action).toBe("deny")
        expect(Permission.evaluate("grep", "*", inherited).action).toBe("allow")
      }),
    { config: { permission: { "*": "allow" } } },
  )

  it.instance("allows explicit edit access only under a parent edit allow", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps() },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      yield* sessions.setPermission({
        sessionID: chat.id,
        permission: [{ permission: "edit", pattern: "*", action: "deny" }],
      })
      const refused = yield* Effect.exit(
        def.execute(
          { description: "Edit findings", prompt: "Update the report", subagent_type: "general", access: "edit" },
          ctx,
        ),
      )
      expect(Exit.isFailure(refused)).toBe(true)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)

      yield* sessions.setPermission({
        sessionID: chat.id,
        permission: [{ permission: "edit", pattern: "*", action: "allow" }],
      })
      const created = yield* def.execute(
        { description: "Edit findings", prompt: "Update the report", subagent_type: "general", access: "edit" },
        ctx,
      )
      const child = yield* sessions.get(created.metadata.sessionId)
      expect(TaskAuthority.read(child.metadata)).toBe("edit")
    }),
  )
  // kilocode_change end

  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  // kilocode_change start // raya_change start - Milestone D intelligent delegation
  it.instance(
    "registers Auto as a cheap-model primary agent with specialist capability cards",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const auto = yield* agents.get("auto")

        expect(auto.mode).toBe("primary")
        expect(`${auto.model?.providerID}/${auto.model?.modelID}`).toBe("kilo/kilo-auto/small")
        for (const name of ["coder", "engineer", "designer", "researcher", "accountant", "reasoner"]) {
          expect(auto.prompt).toContain(`- ${name}:`)
        }
        expect((yield* agents.get("coder")).mode).toBe("subagent")
        expect((yield* agents.get("engineer")).mode).toBe("all")
        expect((yield* agents.get("designer")).mode).toBe("all")
      }),
    { config: { small_model: "kilo/kilo-auto/small" } }, // kilocode_change - make the asserted Auto model explicit
  )

  it.instance("auto-selects the best specialist and sends a bounded structured brief to an isolated child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        {
          description: "Map API routes",
          brief: {
            objective: "Find and map every HTTP API endpoint in the codebase",
            context: "Focus on the server package",
            constraints: ["Do not edit files"],
            expected_return: "A concise endpoint map with source paths",
          },
          step_cap: 4,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "Synthesized endpoint map", onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const child = yield* sessions.get(result.metadata.sessionId)
      expect(child.parentID).toBe(chat.id)
      expect(child.agent).toBe("explore")
      // kilocode_change start - raya_change: durable task identity
      expect(child.title).toBe("Map API routes · Explore")
      expect(child.metadata?.["raya.task.identity"]).toMatchObject({
        version: 1,
        displayName: "Map API routes · Explore",
        baseName: "Map API routes · Explore",
        ordinal: 1,
        specialist: "explore",
        selection: "auto",
        provenance: { source: "description", parentSessionID: chat.id, parentMessageID: assistant.id },
      })
      // kilocode_change end
      expect(child.metadata?.["raya.task.stepCap"]).toBe(4)
      expect(result.metadata).toMatchObject({
        selectedAgent: "explore",
        displayName: "Map API routes · Explore", // kilocode_change - raya_change
        selection: "auto",
        stepCap: 4,
      })
      expect(seen?.agent).toBe("explore")
      expect(result.metadata).toMatchObject({ childMessageID: seen?.messageID }) // kilocode_change - binds the actual child input
      expect(typeof result.metadata.childMessageID).toBe("string") // kilocode_change
      const part = seen?.parts[0]
      expect(part?.type).toBe("text")
      if (part?.type !== "text") throw new Error("expected structured text brief")
      expect(part.text).toContain("<subagent_brief>")
      expect(part.text).toContain("Expected return: A concise endpoint map with source paths")
      expect(result.output).toContain("Synthesized endpoint map")
    }),
  )

  it.instance("routes custom specialist descriptions and applies the task step ceiling", () =>
    Effect.sync(() => {
      const selected = KiloTask.route({
        request: "Audit authentication for security vulnerabilities and unsafe authorization",
        agents: [
          { name: "general", mode: "subagent", description: "General implementation agent" },
          {
            name: "security",
            mode: "subagent",
            description: "Security specialist for authentication vulnerabilities and authorization audits",
          },
        ],
      })

      expect(selected.name).toBe("security")
      expect(KiloTask.steps(undefined, { "raya.task.stepCap": 3 })).toBe(3)
      expect(KiloTask.steps(2, { "raya.task.stepCap": 8 })).toBe(2)
      expect(KiloTask.cap(500)).toBe(80)
    }),
  )

  // raya_change start - Milestone B Auto enforces and records the Chief handoff
  it.instance("Chief records a strict high-confidence decision with measured latency and actual model", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* ChiefRouteTool
      const def = yield* tool.init()
      const chief = {
        ...assistant,
        modelID: ModelV2.ID.make("cheap-model"),
        time: { created: Date.now() - 10 },
      }
      yield* sessions.updateMessage(chief)
      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: { [RayaChief.modelKey]: ref },
      })
      const result = yield* def.execute(
        { objective: "Implement a typed API endpoint and add unit tests" },
        {
          sessionID: chat.id,
          messageID: chief.id,
          agent: "auto",
          callID: "chief-call",
          abort: new AbortController().signal,
          extra: {},
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const updated = yield* sessions.get(chat.id)
      const decisions = RayaChief.history(updated.metadata)

      expect(result.metadata.decision).toMatchObject({
        agent: "coder",
        model: "test/test-model",
        confidence: expect.any(Number),
        reason: "The request is primarily software implementation work.",
        chiefModel: "test/cheap-model",
        prompted: false,
      })
      expect(result.metadata.decision.latency).toBeGreaterThanOrEqual(10)
      expect(result.metadata.decision.latency).toBeLessThan(5_000)
      expect(decisions).toEqual([result.metadata.decision])
      expect(RayaChief.pending(updated.metadata)?.agent).toBe("coder")
    }),
  )

  it.instance("Chief raises an in-chat option question before resolving a low-confidence route", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const questions = yield* Question.Service
      const { chat, assistant } = yield* seed()
      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: {
          [RayaChief.modelKey]: ref,
          [RayaChief.requestKey]: "Help me decide what to do with this project",
          [RayaChief.phaseKey]: "route",
        }, // raya_change - preserve the ambiguous user request despite model rewriting
      })
      const tool = yield* ChiefRouteTool
      const def = yield* tool.init()
      const fiber = yield* def
        .execute(
          { objective: "Implement code by inspecting this repository" }, // raya_change - simulated Chief rewrite
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "auto",
            callID: "chief-call",
            abort: new AbortController().signal,
            extra: {},
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)
      let pending = yield* questions.list()
      for (let attempt = 0; pending.length === 0 && attempt < 100; attempt++) {
        yield* Effect.sleep("50 millis")
        pending = yield* questions.list()
      }

      expect(pending).toHaveLength(1)
      expect(pending[0]?.questions[0]).toMatchObject({
        header: "Choose option",
        multiple: false,
        custom: true,
      })
      expect(pending[0]?.autoSubmit).toBe(false) // last question waits for Submit
      expect(pending[0]?.questions[0]?.options.length).toBeGreaterThanOrEqual(2)
      yield* questions.reply({ requestID: pending[0]!.id, answers: [["designer"]] })
      const result = yield* Fiber.join(fiber)

      expect(result.metadata.decision.agent).toBe("designer")
      expect(result.metadata.decision.request).toBe("Help me decide what to do with this project")
      expect(result.metadata.decision.prompted).toBe(true)
      expect(result.metadata.decision.reason).toContain("user selected designer")
      expect(RayaChief.phase((yield* sessions.get(chat.id)).metadata)).toBe("task")
    }),
  )

  it.instance("Auto delegates only through its pending Chief decision and logs the actual model", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const pending: RayaChief.Pending = {
        request: "Implement a typed API endpoint",
        agent: "coder",
        role: "coder",
        needs_plan: false,
        confidence: 0.94,
        reason: "The request is primarily software implementation work.",
        candidates: [
          {
            agent: "coder",
            role: "coder",
            score: 8,
            reason: "The request is primarily software implementation work.",
          },
        ],
        prompted: false,
        latency: 23,
        chiefModel: "test/cheap-model",
      }
      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: {
          [RayaChief.pendingKey]: pending,
          [RayaChief.modelKey]: ref,
          [RayaChief.logKey]: [{ ...pending, model: "test/test-model" }],
        },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          description: "Implement endpoint",
          subagent_type: "designer",
          brief: { objective: "This narrower model-authored objective must not replace the user's request" },
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "auto",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const updated = yield* sessions.get(chat.id)
      const decisions = RayaChief.history(updated.metadata)

      expect(result.metadata.selectedAgent).toBe("coder")
      expect(result.metadata.model).toEqual(ref)
      expect(updated.metadata?.[RayaChief.pendingKey]).toBeUndefined()
      expect(decisions).toHaveLength(1)
      expect(decisions[0]).toMatchObject({
        agent: "coder",
        model: "test/test-model",
        confidence: 0.94,
        reason: pending.reason,
        chiefModel: "test/cheap-model",
      })
      expect(result.output).toContain("done")
    }),
  )

  // kilocode_change start - persisted Auto continuations delegate without inventing a Chief decision
  it.instance(
    "Auto continuation delegates from its saved objective while a new request still requires Chief",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const ctx = {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "auto",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        yield* sessions.setMetadata({
          sessionID: chat.id,
          metadata: {
            [RayaChief.modelKey]: ref,
            [RayaChief.requestKey]: "Implement a typed API endpoint and tests",
            [RayaChief.phaseKey]: "route",
          },
        })
        const blocked = yield* def
          .execute({ description: "Continue", subagent_type: "designer" }, ctx)
          .pipe(Effect.exit)
        expect(Exit.isFailure(blocked)).toBe(true)
        if (Exit.isFailure(blocked)) expect(Cause.pretty(blocked.cause)).toContain("chief_route on a new request")

        yield* sessions.setMetadata({
          sessionID: chat.id,
          metadata: {
            [RayaChief.modelKey]: ref,
            [RayaChief.requestKey]: "Implement a typed API endpoint and tests",
            [RayaChief.phaseKey]: "task",
          },
        })
        const result = yield* def.execute({ description: "Continue", subagent_type: "designer" }, ctx)
        expect(result.metadata.selectedAgent).toBe("coder")
        expect(result.metadata.selection).toBe("auto")
        expect(seen?.agent).toBe("coder")
        const part = seen?.parts[0]
        expect(part?.type).toBe("text")
        if (part?.type !== "text") throw new Error("expected structured text brief")
        expect(part.text).toContain("Objective: Implement a typed API endpoint and tests")
        expect(RayaChief.history((yield* sessions.get(chat.id)).metadata)).toEqual([])
      }),
    {
      config: {
        enabled_providers: ["test"],
        provider: {
          test: {
            npm: "@ai-sdk/openai-compatible",
            models: { "test-model": { variants: { xhigh: {} } } },
            options: { apiKey: "fixture", baseURL: "http://127.0.0.1:1/v1" },
          },
        },
      },
    },
  )
  // kilocode_change end
  // raya_change end

  it.instance("runs two auto-routed children concurrently and joins both synthesized results", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<void>()
      const gate = defer<void>()
      let started = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            started++
            if (started === 2) ready.resolve()
            return gate.promise
          }).pipe(Effect.as(reply(input, `summary:${input.agent}`))),
      }
      const ctx = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const fiber = yield* Effect.all(
        [
          def.execute(
            {
              description: "Find route files",
              brief: { objective: "Search and map route files in the codebase" },
            },
            ctx,
          ),
          def.execute(
            {
              description: "Implement helper",
              brief: { objective: "Implement a reusable helper and return changed artifact paths" },
            },
            ctx,
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild)

      yield* Effect.promise(() => ready.promise)
      expect(started).toBe(2)
      gate.resolve()
      const results = yield* Fiber.join(fiber)
      expect(new Set(results.map((item) => item.metadata.sessionId)).size).toBe(2)
      // kilocode_change start - raya_change: each routed child exposes its saved identity
      expect(results.map((item) => item.metadata.displayName)).toEqual([
        "Find route files · Explore",
        "Implement helper · General",
      ])
      // kilocode_change end
      expect(results.map((item) => item.metadata.selectedAgent)).toEqual(["explore", "general"])
      expect(results.map((item) => item.output)).toEqual([
        expect.stringContaining("summary:explore"),
        expect.stringContaining("summary:general"),
      ])
    }),
  )
  // kilocode_change end // raya_change end

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(kids[0]?.title).toBe("Existing child") // kilocode_change - raya_change: resume preserves identity
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.metadata.displayName).toBe("Existing child") // kilocode_change - raya_change
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  // kilocode_change start - verify forked task children remain resumable
  it.instance("execute resumes a cloned task session after the parent is forked", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "call_1",
        tool: "task",
        metadata: { sessionId: child.id },
        state: {
          status: "completed",
          input: { description: "inspect bug", prompt: "continue", task_id: child.id },
          output: `<task id="${child.id}"><task_result>done</task_result></task>`,
          title: "inspect bug",
          metadata: { sessionId: child.id },
          time: { start: Date.now(), end: Date.now() },
        },
      } as MessageV2.ToolPart)

      const forked = yield* sessions.fork({ sessionID: chat.id })
      const msgs = yield* sessions.messages({ sessionID: forked.id })
      const part = msgs.flatMap((msg) => msg.parts).find((item) => item.type === "tool" && item.tool === "task") as
        | MessageV2.ToolPart
        | undefined
      if (!part || part.state.status !== "completed") throw new Error("expected a completed task part")
      const id = part.state.input.task_id
      if (typeof id !== "string") throw new Error("expected a cloned task ID")
      const parent = msgs.find((msg) => msg.info.role === "assistant")
      if (!parent || parent.info.role !== "assistant") throw new Error("expected a forked assistant message")

      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "continue from the fork",
          subagent_type: "general",
          task_id: id,
        },
        {
          sessionID: forked.id,
          messageID: parent.info.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.sessionID).toBe(SessionID.descending(id))
      expect((yield* sessions.get(SessionID.descending(id))).parentID).toBe(forked.id)
    }),
  )
  // kilocode_change end

  // kilocode_change start - resumed children rebuild parent platform attribution after restart
  it.instance("execute preserves platform attribution when resuming a task", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      KiloSession.setPlatformOverride(chat.id, "agent-manager")
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      KiloSession.clearPlatformOverride(child.id)
      const tool = yield* TaskTool
      const def = yield* tool.init()

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "continue",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(KiloSession.resolvePlatform(child.id)).toBe("agent-manager")
      expect(KiloSession.resolveRoot(child.id)).toBe(chat.id)
    }),
  )
  // kilocode_change end

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<{ sessionID: SessionID; messageID?: MessageID }>() // kilocode_change
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (
          sessionID,
          messageID, // kilocode_change
        ) =>
          Effect.sync(() => {
            cancelled.resolve({ sessionID, messageID }) // kilocode_change
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      // kilocode_change start - cleanup names the same child input that was executed
      expect(yield* Effect.promise(() => cancelled.promise)).toEqual({
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      // kilocode_change end

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance(
    "prevents subagents from launching subagents by default",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let asked = false

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
            },
            {
              sessionID: child.id,
              messageID: nestedAssistant.id,
              agent: "general",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.sync(() => (asked = true)),
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(asked).toBe(false)
        expect(yield* sessions.children(child.id)).toHaveLength(0)
      }),
    { config: { subagent_depth: 1 } }, // kilocode_change - explicit ceiling; default depth is 2
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        // kilocode_change start — use arrayContaining: Kilo appends inherited caller restrictions
        expect(child.permission).toEqual(
          expect.arrayContaining([
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "bash",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "read",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "task",
              pattern: "*",
              action: "deny",
            },
          ]),
        )
        // kilocode_change end
        expect(seen?.tools).toEqual({
          question: false, // kilocode_change - subagents cannot prompt the user directly
          interactive_terminal: false, // kilocode_change - subagents cannot take over the user's terminal
          todowrite: false,
          task: false, // kilocode_change - Kilo disallows nested subagents
          bash: false,
          read: false,
        })
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
          openTelemetry: true, // kilocode_change
        },
        subagent_depth: 1, // kilocode_change - this fixture asserts the no-nesting permission shape
      },
    },
  )

  // kilocode_change start - terminal child assistant errors fail the task tool boundary
  it.instance("execute fails when child prompt returns assistant error", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            const result = reply(input, "partial")
            if (result.info.role !== "assistant") return result
            return {
              ...result,
              info: {
                ...result.info,
                error: MessageV2.fromError(new Error("child prompt failed"), { providerID: ref.providerID }),
              },
            }
          }),
      }

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)

      // the failure surfaces the resumable task_id so the parent can continue the subagent (#11620)
      const kids = yield* sessions.children(chat.id)
      const childId = kids[0]?.id
      expect(childId).toBeDefined()
      const squashed = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      const message = squashed instanceof Error ? squashed.message : String(squashed)
      expect(message).toContain("child prompt failed")
      expect(message).toContain(`task_id="${childId}"`)
      expect(message).toContain("can be resumed")
    }),
  )
  // kilocode_change end

  // kilocode_change start - background subagent failures also surface the resumable task_id (#11620)
  background.instance("background task failure injects a resumable task_id into the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injected: SessionPrompt.PromptInput[] = []
      const parentInjected = yield* Deferred.make<void>()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) => {
                // The parent-session prompt is the injected background result; capture it.
                if (input.sessionID === chat.id) {
                  injected.push(input)
                  return Effect.as(Deferred.succeed(parentInjected, undefined), reply(input, "ack"))
                }
                return Effect.die(new Error("child prompt failed and can be resumed later"))
              },
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const childId = result.metadata.sessionId
      yield* jobs.wait({ id: childId, timeout: 1_000 })
      // The parent-session injection is forked asynchronously; wait for it before asserting.
      yield* Deferred.await(parentInjected).pipe(Effect.timeout("1 second"))

      const text = injected
        .flatMap((input) => input.parts ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n")
      expect(text).toContain(`state="error"`)
      expect(text).toContain(`task_id="${childId}"`)
      expect(text).toContain("can be resumed")
    }),
  )
  // kilocode_change end
  // kilocode_change start - preserve the disabled-background regression test
  disabled.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
  // kilocode_change end

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  for (const mode of ["completed", "cancelled"]) // kilocode_change - exercise normal and individually cancelled initial invocations
    background.instance(`background task ${mode} initial invocation preserves running updates`, () =>
      // kilocode_change
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const first = defer<void>()
        const second = defer<void>()
        const updated = defer<SessionPrompt.PromptInput>()
        const injected = defer<SessionPrompt.PromptInput>()
        const received: SessionPrompt.PromptInput[] = [] // kilocode_change - verify recorded child identities against executed inputs
        const cancelled: { sessionID: SessionID; messageID?: MessageID }[] = [] // kilocode_change
        let prompts = 0
        const promptOps: TaskPromptOps = {
          ...stubOps(),
          cancel: (sessionID, messageID) =>
            Effect.sync(() => {
              cancelled.push({ sessionID, messageID })
            }), // kilocode_change
          prompt: (input) => {
            if (input.sessionID === chat.id) {
              injected.resolve(input)
              return Effect.succeed(reply(input, "done"))
            }
            prompts++
            received.push(input) // kilocode_change
            if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
            updated.resolve(input)
            return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
          },
        }
        const context = {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          callID: "first", // kilocode_change - identify each task admission independently
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }

        const started = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          context,
        )
        const observed = yield* jobs.get(started.metadata.sessionId) // kilocode_change - capture before extension admission
        const result = yield* def.execute(
          {
            description: "add investigation scope",
            prompt: "also inspect cancellation",
            subagent_type: "general",
            task_id: started.metadata.sessionId,
          },
          { ...context, callID: "second" }, // kilocode_change
        )

        // kilocode_change start - real task starts and extensions preserve their source invocation
        const origins = (yield* jobs.get(started.metadata.sessionId))?.origins
        expect(origins).toMatchObject([
          { sessionID: chat.id, messageID: assistant.id, callID: "first" },
          { sessionID: chat.id, messageID: assistant.id, callID: "second" },
        ])
        expect(origins?.[0]?.childSessionID).toBe(started.metadata.sessionId)
        expect(origins?.[0]?.childMessageID).toBe(received[0].messageID)
        expect(started.metadata).toMatchObject({ childMessageID: origins?.[0]?.childMessageID })
        expect(result.metadata).toMatchObject({ childMessageID: origins?.[1]?.childMessageID })
        expect(origins?.[1]?.childSessionID).toBe(started.metadata.sessionId)
        expect(typeof origins?.[1]?.childMessageID).toBe("string")
        expect(origins?.[1]?.childMessageID).not.toBe(origins?.[0]?.childMessageID)
        expect(yield* jobs.cancel(started.metadata.sessionId, observed!.revision)).toBeUndefined()
        // kilocode_change end

        expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
        expect(result.metadata.background).toBe(true)
        expect(result.output).toContain("Background task updated")
        // kilocode_change start - route exact invocation cleanup through the actual task wrapper
        if (mode === "cancelled") {
          const current = (yield* jobs.get(started.metadata.sessionId))!
          expect(
            yield* jobs.cancelInput(started.metadata.sessionId, current.revision!, origins![0]!.childMessageID!),
          ).toBe(true)
          expect(cancelled).toEqual([{ sessionID: started.metadata.sessionId, messageID: received[0].messageID }])
        }
        if (mode === "completed") first.resolve()
        // kilocode_change end
        expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
        // kilocode_change start // raya_change start - task updates now carry structured briefs
        const update = yield* Effect.promise(() => updated.promise)
        expect(origins?.[1]?.childMessageID).toBe(update.messageID) // kilocode_change - queued work uses its reserved identity
        expect(update.parts[0]?.type).toBe("text")
        if (update.parts[0]?.type !== "text") throw new Error("expected structured task update")
        expect(update.parts[0].text).toContain("Objective: also inspect cancellation")
        // kilocode_change end // raya_change end

        second.resolve()
        const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
        expect(waited.info?.status).toBe("completed")
        expect(waited.info?.output).toBe("second done")
        const notification = yield* Effect.promise(() => injected.promise)
        expect(notification.variant).toBe("xhigh")
        expect(notification.parts[0]?.type).toBe("text")
        if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
      }),
    )

  // kilocode_change start - completed background tasks propagate their invocation cost delta
  background.instance("background tasks propagate child cost to the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ sessions, childCost: 0.2 }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
      expect(parent.info.role === "assistant" ? parent.info.cost : 0).toBeCloseTo(0.2, 6)
    }),
  )
  // kilocode_change end

  // kilocode_change start - the background.extend() path must also propagate its run's cost delta (regression)
  background.instance("extended background tasks propagate the extended run's cost to the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      let childPrompts = 0
      // Each child prompt persists a 0.2 cost delta, so the child session totals 0.2 after the
      // initial run and 0.4 after the extended run. Blocking each run keeps the job "running"
      // long enough for the second execute() to hit background.extend() rather than a fresh start.
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.gen(function* () {
            const rep = reply(input, "done")
            if (input.sessionID === chat.id) return rep
            yield* sessions.updateMessage({ ...rep.info, cost: 0.2 })
            childPrompts++
            if (childPrompts === 1) yield* Effect.promise(() => first.promise)
            else yield* Effect.promise(() => second.promise)
            return rep
          }),
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const extended = yield* def.execute(
        {
          description: "extend investigation",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )
      expect(extended.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(extended.output).toContain("Background task updated")

      first.resolve()
      second.resolve()
      yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
      // Both the initial run and the extended run propagate their 0.2 delta; a missing bracket on the
      // extend path would leave the parent at 0.2.
      expect(parent.info.role === "assistant" ? parent.info.cost : 0).toBeCloseTo(0.4, 6)
    }),
  )
  // kilocode_change end

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})

// kilocode_change start - subagent cost propagation coverage (#6321)
const assistantCost = Effect.fn("TaskToolTest.assistantCost")(function* (sessionID: string) {
  const sessions = yield* Session.Service
  const msgs = yield* sessions.messages({ sessionID: SessionID.make(sessionID) })
  return msgs.reduce((sum, m) => sum + (m.info.role === "assistant" ? m.info.cost : 0), 0)
})

describe("tool.task cost propagation", () => {
  it.live("propagates subagent cost to parent assistant message", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const promptOps = stubOps({ sessions, childCost: 0.25 })

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
        expect(parent.info.role).toBe("assistant")
        if (parent.info.role !== "assistant") return
        expect(parent.info.cost).toBeCloseTo(0.25, 6)
      }),
    ),
  )

  it.live("propagates recursively through nested subagent costs", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        // Pre-create a child with its own assistant already bearing a grandchild cost.
        const child = yield* sessions.create({ parentID: chat.id, title: "grandchild-accumulated" })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: assistant.id,
          sessionID: child.id,
          mode: "build",
          agent: "general",
          cost: 0.4,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        })

        const tool = yield* TaskTool
        const def = yield* tool.init()
        // Resuming into the same child via task_id and the stub tacks on another 0.15.
        const promptOps = stubOps({ sessions, childCost: 0.15 })

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
        if (parent.info.role !== "assistant") return
        // Only the delta since the start of this invocation propagates.
        expect(parent.info.cost).toBeCloseTo(0.15, 6)
        // Child session keeps the full cumulative total (0.4 pre-existing + 0.15 this run).
        expect(yield* assistantCost(child.id)).toBeCloseTo(0.55, 6)
      }),
    ),
  )

  it.live("resumed task_id only propagates the delta", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "resume target" })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: assistant.id,
          sessionID: child.id,
          mode: "build",
          agent: "general",
          cost: 0.1,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        })

        const tool = yield* TaskTool
        const def = yield* tool.init()
        const promptOps = stubOps({ sessions, childCost: 0.05 })

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "continue investigation",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
        if (parent.info.role !== "assistant") return
        // Delta-only: only the 0.05 from this run, not 0.15 including the pre-existing 0.10.
        expect(parent.info.cost).toBeCloseTo(0.05, 6)
      }),
    ),
  )

  it.live("propagates partial cost on abort", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const abort = new AbortController()
        // Stub that persists a partial cost, then aborts — mimics interrupted run after tokens billed.
        const ops: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              const info: MessageV2.Assistant = {
                id: MessageID.ascending(),
                role: "assistant",
                parentID: input.messageID ?? MessageID.ascending(),
                sessionID: input.sessionID,
                mode: "general",
                agent: "general",
                cost: 0.07,
                path: { cwd: "/tmp", root: "/tmp" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ref.modelID,
                providerID: ref.providerID,
                time: { created: Date.now() },
              }
              yield* sessions.updateMessage(info)
              abort.abort()
              return yield* Effect.interrupt
            }),
        }

        yield* def
          .execute(
            {
              description: "partial",
              prompt: "will abort",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: abort.signal,
              extra: { promptOps: ops },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        const parent = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.id === assistant.id)!
        if (parent.info.role !== "assistant") return
        expect(parent.info.cost).toBeCloseTo(0.07, 6)
      }),
    ),
  )
})
// kilocode_change end
