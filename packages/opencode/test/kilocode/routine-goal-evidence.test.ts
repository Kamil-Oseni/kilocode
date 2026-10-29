import { expect } from "bun:test"
import path from "node:path"
import { Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import {
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineMessageTable as Inbox,
} from "@opencode-ai/core/kilocode/routine.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { MessageID, PartID } from "@/session/schema"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskDelegation, prompt, type Record as Request } from "@/kilocode/task/delegation"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { final } from "@/kilocode/task/final-report"
import { routineManagementTools } from "@/kilocode/tool/routine-management"
import * as Artifact from "@/kilocode/goal/artifact"
import * as AssignmentRefusal from "@/kilocode/task/assignment-refusal"
import { ownerContext } from "@/kilocode/task/request"
import * as RoutineWait from "@/kilocode/goal/routine-wait"
import { RayaChief } from "@/kilocode/chief"
import { ToolRegistry } from "@/tool/registry"
import { testEffect } from "../lib/effect"
import { database, storage } from "./fixtures/effect-profile"
import { provideTmpdirInstance } from "../fixture/fixture"
import type * as Tool from "@/tool/tool"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Truncate.node,
      Permission.node,
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      Storage.node,
      Database.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      ToolRegistry.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }

it.live(
  "irreducible original owner context produces a native refusal without another model or assignment",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const info = yield* routineManagementTools({ storage, database, sessions }).assignOrganizationWork
        const tool = yield* info.init()
        const prefix = "Run one manual saved local team job through Dispatch -> Researcher -> Builder -> Sales. "
        for (const length of [4200, 3990, 100]) {
          const owner = prefix.padEnd(length, "x")
          const session = yield* sessions.create({
            agent: "auto",
            metadata: { [RayaChief.requestKey]: owner, [RayaChief.phaseKey]: "route" },
          })
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "auto",
            model,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: user.id,
            type: "text",
            text: owner,
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            parentID: user.id,
            role: "assistant",
            agent: "auto",
            mode: "auto",
            providerID: model.providerID,
            modelID: model.modelID,
            cost: 0,
            path: { cwd: directory, root: directory },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          })
          const callID = `owner-limit-${length}`
          const ctx: Tool.Context = {
            sessionID: session.id,
            messageID: assistant.id,
            callID,
            agent: "auto",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.die("Pre-admission refusal must not ask for permission"),
          }
          const params = {
            organizationID: `org_${"a".repeat(32)}`,
            expectedRevision: 1,
            senderID: "sender",
            recipientID: "recipient",
            objective: "Read the assigned source",
            outputs: [],
            criteria: [
              { id: "read", description: "Read the approved source", verification: "Cite the actual Read receipt" },
            ],
            ...(length === 100 ? { context: "y".repeat(3990) } : {}),
          }
          const id = PartID.ascending()
          const start = Date.now()
          yield* sessions.updatePart({
            id,
            sessionID: session.id,
            messageID: assistant.id,
            type: "tool",
            tool: "assign_organization_work",
            callID,
            state: { status: "running", input: params, time: { start } },
          })
          const result = yield* tool.execute(params, ctx)
          expect(result.metadata.requestStatus).toBe("unresolved")
          expect(result.output).toContain("4000-character context limit")
          yield* sessions.updatePart({
            id,
            sessionID: session.id,
            messageID: assistant.id,
            type: "tool",
            tool: "assign_organization_work",
            callID,
            state: {
              status: "completed",
              input: params,
              output: result.output,
              title: result.title,
              metadata: result.metadata,
              time: { start, end: Date.now() },
            },
          })
          yield* sessions.updateMessage({
            ...assistant,
            finish: "tool-calls",
            time: { created: assistant.time.created, completed: Date.now() },
          })
          const metadata: Record<string, unknown> = result.metadata
          if (length === 100) {
            expect(metadata[AssignmentRefusal.key]).toBeUndefined()
            expect(yield* AssignmentRefusal.finish(sessions, session.id, user.id)).toBe(false)
            continue
          }
          expect(metadata[AssignmentRefusal.key]).toMatchObject({ userID: user.id, messageID: assistant.id, callID })
          expect(ownerContext(owner).length).toBeGreaterThan(4000)
          const failed = yield* sessions.updateMessage({
            ...assistant,
            id: MessageID.ascending(),
            error: { name: "UnknownError", data: { message: "Later parent failure" } },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: failed.id,
            type: "tool",
            tool: "assign_organization_work",
            callID: "accepted-before-error",
            state: {
              status: "completed",
              input: params,
              output: "Actually accepted",
              title: "Assignment",
              metadata: { requestStatus: "complete", delegationID: "actual-side-effect" },
              time: { start, end: Date.now() },
            },
          })
          expect(yield* AssignmentRefusal.finish(sessions, session.id, user.id)).toBe(false)
          yield* sessions.removeMessage({ sessionID: session.id, messageID: failed.id })
          expect(yield* AssignmentRefusal.finish(sessions, session.id, user.id)).toBe(true)
          const after = yield* sessions.messages({ sessionID: session.id })
          const last = after.at(-1)
          expect(last?.info.role).toBe("assistant")
          expect(last?.parts.find((part) => part.type === "text")?.text).toContain(
            `requires ${ownerContext(owner).length} characters`,
          )
          expect(last?.parts.find((part) => part.type === "text")?.text).toContain("This team job was not started")
          expect(yield* AssignmentRefusal.finish(sessions, session.id, user.id)).toBe(true)
          expect((yield* sessions.messages({ sessionID: session.id })).length).toBe(after.length)
          expect(
            (yield* sessions.messages({ sessionID: session.id }))
              .find((row) => row.info.id === user.id)
              ?.parts.find((part) => part.type === "text")?.text,
          ).toBe(owner)
        }
        expect(yield* database.db.select().from(Delegation).all()).toEqual([])
        expect(yield* RayaTask.make({ storage, database }).list()).toEqual([])
      }),
    ),
  60000,
)

it.live(
  "resumed Routine goal can audit actual current-run child handoff without granting output ownership",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const fs = yield* FSUtil.Service
        const tasks = RayaTask.make({ storage, database })
        const goals = RayaGoal.make({ storage, database, sessions })
        const starts = RayaTaskSnapshot.make({ storage })
        const workers: RayaTask.Agent[] = []
        for (const name of ["Dispatch", "Researcher", "Builder", "Sales"])
          workers.push(
            yield* tasks.create({
              name,
              role: "generalist",
              objective: "Perform assigned work",
              capabilities: [],
              dir: directory,
              access: "full",
              tools: ["get_goal", "update_goal", "read", "write", "delegate_work", "inspect_team"],
              schedule: { kind: "manual" },
              output: {
                destination: "conversation",
                description: "Produce assigned files and handoff",
                criteria: [
                  {
                    id: "handoff",
                    description: "Hand off the produced files",
                    verification: "Use an accepted delegate_work receipt with actual file artifacts",
                  },
                ],
              },
            }),
          )
        const dispatch = workers[0]
        const researcher = workers[1]
        const builder = workers[2]
        const sales = workers[3]
        const organizations = RayaTaskOrganization.make(database, tasks, storage)
        const team = yield* organizations.create({
          name: "Evidence team",
          purpose: "Read-only evidence bridge fixture",
          members: workers.map((item) => ({ agentID: item.id, role: item.name })),
          delegations: [
            { senderID: dispatch.id, recipientID: researcher.id },
            { senderID: researcher.id, recipientID: builder.id },
            { senderID: builder.id, recipientID: sales.id },
          ],
        })
        const errands = RayaTaskDelegation.make(database, organizations.authorize, organizations.shares)
        const criteria = [
          {
            id: "handoff",
            description: "Hand off the produced files",
            verification: "Use an accepted delegate_work receipt with actual file artifacts",
          },
        ]
        const files = ["research.md", "index.html", "builder-brief.md"].map((file) => path.join(directory, file))
        const seed = yield* errands.admit(
          {
            source: "test:original-owner",
            senderID: dispatch.id,
            recipientID: researcher.id,
            organizationID: team.id,
            organizationRevision: team.revision,
            objective:
              "Create research.md and hand it to Builder; accept Builder's actual two-file onward handoff receipt",
            criteria,
            outputs: [files[0]],
          },
          dispatch,
          researcher,
        )
        const open = (agent: RayaTask.Agent, row: Request, sender: RayaTask.Agent) =>
          Effect.gen(function* () {
            const admitted = yield* errands.take(agent.id)
            if (!admitted?.childRunID || admitted.id !== row.id)
              throw new Error("Actual queued delegation was not reserved")
            const rid = admitted.childRunID
            const session = yield* sessions.create({
              agent: "generalist",
              metadata: {
                rayaRoutine: {
                  version: 1,
                  agentID: agent.id,
                  runID: rid,
                  scheduleVersion: 1,
                  trigger: { kind: "manual" },
                  delegationID: row.id,
                  organizationID: team.id,
                  organizationRevision: team.revision,
                  outputs: row.outputs,
                },
              },
              permission: RayaTask.rules(agent, directory),
            })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              agent: "generalist",
              model,
              time: { created: Date.now() },
            })
            const objective = prompt(sender, agent, row)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: user.id,
              type: "text",
              text: objective,
            })
            const goal = yield* goals.create(
              session.id,
              objective,
              user.id,
              undefined,
              undefined,
              row.criteria,
              undefined,
              undefined,
              { agentID: agent.id, runID: rid, sessionID: session.id },
            )
            yield* goals.initial(session.id, goal.intent!, "actual-fixture")
            const run = yield* tasks.record({
              id: rid,
              agentID: agent.id,
              sessionID: session.id,
              at: Date.now(),
              status: "running",
              trigger: { kind: "manual" },
              scheduleVersion: 1,
              goalCreatedAt: goal.createdAt,
            })
            yield* starts.save({
              version: 2,
              runID: rid,
              sessionID: session.id,
              agentID: agent.id,
              at: run.at,
              definition: agent,
              objective,
              outputs: row.outputs,
            })
            yield* errands.attach(row.id, rid, session.id)
            const assistant = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              parentID: user.id,
              role: "assistant",
              agent: "generalist",
              mode: "generalist",
              providerID: model.providerID,
              modelID: model.modelID,
              cost: 0,
              path: { cwd: directory, root: directory },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now() },
            })
            const ctx = (callID: string): Tool.Context => ({
              sessionID: session.id,
              messageID: assistant.id,
              callID,
              agent: "generalist",
              abort: AbortSignal.any([]),
              messages: [],
              extra: {},
              metadata: () => Effect.void,
              ask: () => Effect.void,
            })
            return { session, user, assistant, run, goal, ctx }
          })
        const root = yield* open(researcher, seed.record, dispatch)
        const busy = (agent: RayaTask.Agent) =>
          Effect.gen(function* () {
            const session = yield* sessions.create({ title: "Busy fixture prevents inference" })
            return yield* tasks.record({
              id: crypto.randomUUID(),
              agentID: agent.id,
              sessionID: session.id,
              at: Date.now(),
              status: "running",
              trigger: { kind: "manual" },
              scheduleVersion: 1,
            })
          })
        const held = yield* busy(builder)
        yield* busy(sales)
        const write = (target: typeof root, file: string, callID: string) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(file, `Actual authored ${path.basename(file)}\n`)
            const revision = yield* Artifact.capture(fs, file)
            if (revision.status !== "captured") throw new Error("Actual file capture failed")
            yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: target.session.id,
              messageID: target.assistant.id,
              type: "tool",
              tool: "write",
              callID,
              state: {
                status: "completed",
                input: { filePath: file },
                output: "Actual file saved",
                title: "Saved file",
                metadata: { rayaRevision: revision },
                time: { start: Date.now(), end: Date.now() },
              },
            })
          })
        const tools = routineManagementTools({ storage, database, sessions })
        const tool = yield* tools.delegateWork
        const delegate = yield* tool.init()
        const handoff = (
          target: typeof root,
          agent: RayaTask.Agent,
          input: string[],
          outputs: string[],
          callID: string,
        ) =>
          Effect.gen(function* () {
            const params = {
              organizationID: team.id,
              expectedRevision: team.revision,
              recipientID: agent.id,
              objective: "Save assigned files and pass actual produced files onward",
              artifacts: input,
              outputs,
              criteria,
            }
            const id = PartID.ascending()
            const start = Date.now()
            yield* sessions.updatePart({
              id,
              sessionID: target.session.id,
              messageID: target.assistant.id,
              type: "tool",
              tool: "delegate_work",
              callID,
              state: { status: "running", input: params, time: { start } },
            })
            const result = yield* delegate.execute(params, target.ctx(callID))
            expect(result.metadata.requestStatus).toBe("complete")
            yield* sessions.updatePart({
              id,
              sessionID: target.session.id,
              messageID: target.assistant.id,
              type: "tool",
              tool: "delegate_work",
              callID,
              state: {
                status: "completed",
                input: params,
                output: result.output,
                title: result.title,
                metadata: result.metadata,
                time: { start, end: Date.now() },
              },
            })
            const metadata: Record<string, unknown> = result.metadata
            if (typeof metadata.delegationID !== "string") throw new Error("Actual delegation ID unavailable")
            return yield* errands.get(metadata.delegationID)
          })
        yield* write(root, files[0], "research-write")
        const assigned = yield* handoff(root, builder, [files[0]], files.slice(1), "research-handoff")
        yield* tasks.transition(held, { ...held, status: "complete" })
        const child = yield* open(builder, assigned, researcher)
        const blocked = { status: "blocked" as const, reason: "Awaiting Builder" }
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: root.session.id,
          messageID: root.assistant.id,
          type: "tool",
          tool: "update_goal",
          callID: "wait-for-builder",
          state: { status: "running", input: blocked, time: { start: Date.now() } },
        })
        const catalog = yield* (yield* ToolRegistry.Service).all()
        const update = catalog.find((tool) => tool.id === "update_goal")
        const get = catalog.find((tool) => tool.id === "get_goal")
        if (!update || !get) throw new Error("Production model-facing Goal tools are unavailable")
        const output = yield* update.execute(blocked, root.ctx("wait-for-builder"))
        const waiting = yield* goals.get(root.session.id)
        if (!waiting) throw new Error("Model-facing Goal update removed the Goal")
        expect(output.metadata.status).toBe("paused")
        expect(waiting.status).toBe("paused")
        expect(waiting.pause).toBe("agent")
        expect((yield* errands.get(seed.record.id)).state).toBe("running")
        yield* sessions.updatePart({
          ...part,
          type: "tool",
          tool: "update_goal",
          callID: "wait-for-builder",
          state: {
            status: "completed",
            input: blocked,
            output: "Waiting for the original child",
            title: "Waiting",
            metadata: { status: "paused" },
            time: { start: Date.now(), end: Date.now() },
          },
        })
        expect(yield* RoutineWait.parked(storage, root.session.id, root.user.id)).toBe(true)
        yield* goals.control(root.session.id, "paused")
        expect(
          (yield* goals.delegated(root.session.id, root.run.id, (next) => Effect.succeed(next.revision!))).resumed,
        ).toBe(false)
        expect((yield* goals.get(root.session.id))?.pause).toBe("user-control")
        yield* storage.replace(["raya", "goal", root.session.id], waiting)
        yield* write(child, files[1], "builder-html")
        yield* write(child, files[2], "builder-brief")
        const privatefile = path.join(directory, "private-source.txt")
        yield* fs.writeFileString(privatefile, "PRIVATE INPUT MUST NOT CROSS THE ROUTINE BRIDGE\n")
        const privateproof = yield* Artifact.capture(fs, privatefile)
        if (privateproof.status !== "captured") throw new Error("Actual private input capture failed")
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.session.id,
          messageID: child.assistant.id,
          type: "tool",
          tool: "read",
          callID: "builder-private-input",
          state: {
            status: "completed",
            input: { filePath: privatefile },
            output: yield* fs.readFileString(privatefile),
            title: "Private source read",
            metadata: { rayaRevision: privateproof },
            time: { start: Date.now(), end: Date.now() },
          },
        })
        const onward = yield* handoff(child, sales, files.slice(1), [], "builder-sales-handoff")
        expect(onward.artifacts).toHaveLength(2)
        const continuation = yield* sessions.updateMessage({
          ...child.user,
          id: MessageID.ascending(),
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.session.id,
          messageID: continuation.id,
          type: "text",
          synthetic: true,
          text: "Continue the same accepted assignment.",
        })
        yield* goals.follow(child.session.id, child.goal.intent!, continuation.id, "actual-child-continuation")
        child.assistant = yield* sessions.updateMessage({
          ...child.assistant,
          id: MessageID.ascending(),
          parentID: continuation.id,
          time: { created: Date.now() },
        })
        expect((yield* goals.get(child.session.id))?.inputs).toHaveLength(2)
        yield* goals.update(child.session.id, {
          status: "complete",
          summary: "Actual child handoff",
          requirements: [
            {
              criterionID: "handoff",
              requirement: criteria[0].description,
              passed: true,
              evidence: [{ callID: "builder-sales-handoff", summary: "Actual two-file accepted handoff" }],
            },
          ],
        })
        const summary = "Builder handed both actual files to Sales."
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.session.id,
          messageID: child.assistant.id,
          type: "text",
          text: summary,
        })
        yield* sessions.updateMessage({
          ...child.assistant,
          finish: "stop",
          time: { created: child.assistant.time.created, completed: Date.now() },
        })
        yield* goals.finished(child.session.id, child.assistant.id)
        const complete = yield* goals.get(child.session.id)
        if (!complete) throw new Error("Child Goal disappeared")
        const result = final(child.run, complete, yield* sessions.messages({ sessionID: child.session.id }))
        if (!result) throw new Error("Actual final reply was not bound")
        const childhistory = yield* storage.read<unknown>(["raya", "agent-runs", builder.id])
        const running = yield* database.db.select().from(Delegation).where(eq(Delegation.id, assigned.id)).get()
        if (!running) throw new Error("Original child delegation disappeared")
        const terminal = (yield* tasks.runsFor(builder.id)).find((run) => run.id === child.run.id)
        if (!terminal) throw new Error("Original child run disappeared")
        const failure = "The original Builder could not finish its accepted assignment."
        expect(
          yield* tasks.transition(terminal, {
            ...terminal,
            status: "error",
            blockedReason: failure,
            outcome: { kind: "code", summary: failure, cost: 0 },
          }),
        ).toBe(true)
        yield* errands.finish(assigned.id, "failed", builder, failure, 0, failure)
        const failed = yield* goals.delegated(root.session.id, root.run.id, (next) => Effect.succeed(next.revision!))
        expect(failed.resumed).toBe(true)
        expect(failed.state.status).toBe("active")
        expect((yield* goals.evidence(root.session.id)).some((item) => item.callID === "builder-sales-handoff")).toBe(
          false,
        )
        yield* storage.replace(["raya", "goal", root.session.id], waiting)
        yield* storage.replace(["raya", "agent-runs", builder.id], childhistory)
        yield* database.db.update(Delegation).set(running).where(eq(Delegation.id, assigned.id)).run()
        yield* database.db
          .delete(Inbox)
          .where(eq(Inbox.source, `reply:${running.source}`))
          .run()
        yield* tasks.transition(
          child.run,
          { ...child.run, status: "complete", outcome: { kind: "code", summary, report: result.report, cost: 0 } },
          complete,
        )
        yield* errands.finish(assigned.id, "completed", builder, summary, 0)
        const parenthistory = yield* storage.read<unknown>(["raya", "agent-runs", researcher.id])
        yield* tasks.transition(root.run, {
          ...root.run,
          status: "stopped",
          stop: { version: 1, intent: crypto.randomUUID(), at: Date.now() },
        })
        expect(
          Exit.isFailure(
            yield* goals
              .delegated(root.session.id, root.run.id, (next) => Effect.succeed(next.revision!))
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* goals.get(root.session.id))?.status).toBe("paused")
        yield* storage.replace(["raya", "agent-runs", researcher.id], parenthistory)
        const retained = yield* goals.get(root.session.id)
        yield* storage.replace(["raya", "goal", root.session.id], { ...retained, dependencyWait: undefined })
        expect(
          (yield* goals.delegated(root.session.id, root.run.id, (next) => Effect.succeed(next.revision!))).resumed,
        ).toBe(false)
        yield* storage.replace(["raya", "goal", root.session.id], retained)
        const awakened = yield* goals.delegated(root.session.id, root.run.id, (next) => Effect.succeed(next.revision!))
        expect(awakened.resumed).toBe(true)
        expect(awakened.state.status).toBe("active")
        const observed = yield* get.execute({}, root.ctx("observe-real-child"))
        expect(observed.output).toContain("builder-sales-handoff")
        const before = yield* goals.get(root.session.id)
        yield* goals.update(root.session.id, { status: "paused", reason: "Waiting for Builder" })
        yield* goals.update(root.session.id, { status: "active" })
        const resumed = yield* goals.get(root.session.id)
        expect(resumed?.intent).not.toBe(before?.intent)
        const evidence = yield* goals.evidence(root.session.id)
        const actual = evidence.find((item) => item.callID === "builder-sales-handoff")
        expect(evidence.some((item) => item.callID === "builder-private-input")).toBe(false)
        expect(JSON.stringify(evidence)).not.toContain("PRIVATE INPUT MUST NOT CROSS")
        expect(actual?.sessionID).toBe(child.session.id)
        expect(actual?.delegation?.artifacts).toHaveLength(2)
        expect(evidence.find((item) => item.callID === "research-handoff")?.delegation?.reply).toBe(summary)
        expect(evidence.find((item) => item.callID === "research-handoff")?.delegation?.workerAuthored).toBe(true)
        yield* database.db
          .update(SessionTable)
          .set({ agent: "foreign-mode" })
          .where(eq(SessionTable.id, child.session.id))
          .run()
        expect(Exit.isFailure(yield* goals.evidence(root.session.id).pipe(Effect.exit))).toBe(true)
        yield* database.db
          .update(SessionTable)
          .set({ agent: "generalist" })
          .where(eq(SessionTable.id, child.session.id))
          .run()
        const savedgoal = yield* storage.read<RayaGoal.State>(["raya", "goal", child.session.id])
        yield* storage.replace(["raya", "goal", child.session.id], { ...savedgoal, inputs: [root.user.id] })
        expect(Exit.isFailure(yield* goals.evidence(root.session.id).pipe(Effect.exit))).toBe(true)
        yield* storage.replace(["raya", "goal", child.session.id], savedgoal)
        for (const change of [
          { response: "A spliced worker report" },
          { session_id: root.session.id },
          { parent_run_id: "foreign-run" },
          { source: "delegate:foreign-invocation" },
        ]) {
          const saved = yield* database.db.select().from(Delegation).where(eq(Delegation.id, assigned.id)).get()
          if (!saved) throw new Error("Delegation fixture disappeared")
          yield* database.db.update(Delegation).set(change).where(eq(Delegation.id, assigned.id)).run()
          expect(Exit.isFailure(yield* goals.evidence(root.session.id).pipe(Effect.exit))).toBe(true)
          yield* database.db.update(Delegation).set(saved).where(eq(Delegation.id, assigned.id)).run()
        }
        const savedrow = yield* database.db.select().from(Delegation).where(eq(Delegation.id, assigned.id)).get()
        if (!savedrow) throw new Error("Actual delegation disappeared before overflow test")
        const overflow = Array.from({ length: 4 }, (_, index) => ({
          ...savedrow,
          id: `overflow-${index}`,
          source: `test:overflow-${index}`,
        }))
        yield* database.db.insert(Delegation).values(overflow).run()
        expect(Exit.isFailure(yield* goals.evidence(root.session.id).pipe(Effect.exit))).toBe(true)
        for (const row of overflow) yield* database.db.delete(Delegation).where(eq(Delegation.id, row.id)).run()
        yield* fs.writeFileString(files[1], "Changed after receipt capture\n")
        const stale = yield* goals
          .update(root.session.id, {
            status: "complete",
            summary: "Must refuse stale child bytes",
            requirements: [
              {
                criterionID: "handoff",
                requirement: criteria[0].description,
                passed: true,
                evidence: [
                  { callID: "builder-html", sessionID: child.session.id, summary: "Old child bytes" },
                  { callID: "builder-sales-handoff", sessionID: child.session.id, summary: "Actual handoff" },
                ],
              },
            ],
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(stale)).toBe(true)
        expect((yield* goals.get(root.session.id))?.status).toBe("active")
        yield* goals.update(root.session.id, {
          status: "complete",
          summary: "Research and genuine onward handoff evidenced",
          requirements: [
            {
              criterionID: "handoff",
              requirement: criteria[0].description,
              passed: true,
              evidence: [
                {
                  callID: "builder-sales-handoff",
                  sessionID: child.session.id,
                  summary: "Actual accepted two-file handoff",
                },
              ],
            },
          ],
        })
        const done = yield* goals.get(root.session.id)
        expect(done?.status).toBe("complete")
        expect(done?.deliverables ?? []).toEqual([])
        expect(
          yield* tasks.transition(root.run, {
            ...root.run,
            status: "stopped",
            stop: { version: 1, intent: crypto.randomUUID(), at: Date.now() },
          }),
        ).toBe(true)
        expect(Exit.isFailure(yield* goals.evidence(root.session.id).pipe(Effect.exit))).toBe(true)
      }),
    ),
  60000,
)
