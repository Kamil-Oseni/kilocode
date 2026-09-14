import { expect } from "bun:test"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { Git } from "@/git"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
import { KiloToolRegistry } from "@/kilocode/tool/registry"
import { routineManagementTools } from "@/kilocode/tool/routine-management"
import * as Permission from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import type * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Permission.node),
    AppNodeBuilder.build(Truncate.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    AppNodeBuilder.build(FSUtil.node),
    AppNodeBuilder.build(Git.node),
  ),
)

const sessions = {
  create: () => Effect.die("must not start a session"),
  get: () => Effect.die("must not read a session"),
  messages: () => Effect.succeed([]),
  children: () => Effect.succeed([]),
}

function context(callID: string): Tool.Context {
  return {
    sessionID: SessionID.make("ses_routine_management"),
    messageID: MessageID.make("msg_routine_management"),
    callID,
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const output = (name: string) => ({
  destination: "conversation" as const,
  description: `${name} report`,
  criteria: [{ id: "evidence", description: "Show the evidence", verification: "Cite the source" }],
})

it.live(
  "main-chat organization creation recovers a lost result without duplicate workers",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const failed = { saves: 0 }
        const unreliable = {
          ...storage,
          replace: (key: string[], value: unknown) =>
            key[0] === "raya" && key[1] === "agent" && ++failed.saves === 2
              ? Effect.sync(() => {
                  throw new Error("simulated crash after the first worker")
                })
              : storage.replace(key, value),
        }
        const params = {
          name: "Website Builders",
          purpose: "Find, design, build, and sell better business websites.",
          workers: [
            {
              kind: "new" as const,
              key: "chief",
              name: "Chief of Staff",
              role: "CEO",
              objective: "Coordinate the company",
              output: output("Company"),
              capabilities: [],
              access: "brief" as const,
              tools: ["inspect_team", "delegate_work"],
              when: "only when I ask",
              delegatesTo: ["design"],
            },
            {
              kind: "new" as const,
              key: "design",
              name: "Design Lead",
              role: "Designer",
              objective: "Design client websites",
              output: output("Design"),
              capabilities: [],
              access: "full" as const,
              tools: ["read", "browser_*"],
              when: "every Friday at 5pm",
              timezone: "America/Toronto",
              supervisorKey: "chief",
            },
          ],
        }
        const broken = routineManagementTools({ database, storage: unreliable, sessions })
        const create = yield* (yield* broken.create).init()
        const first = yield* create.execute(params, context("create-company")).pipe(Effect.exit)
        expect(Exit.isFailure(first)).toBe(true)
        const staged = yield* RayaTask.make({ storage, database }).list()
        expect(staged).toHaveLength(1)
        expect(staged[0]?.enabled).toBe(false)
        expect(
          (yield* RayaTaskOrganization.make(database, RayaTask.make({ storage, database }), storage).list()).items,
        ).toHaveLength(0)

        const tools = routineManagementTools({ database, storage, sessions })
        const retry = yield* (yield* tools.create).init()
        const recovered = yield* retry.execute(params, context("create-company"))
        expect(recovered.title).toBe("Organization created")
        expect(recovered.metadata).toMatchObject({ requestStatus: "complete", view: "routines" })
        const agents = yield* RayaTask.make({ storage, database }).list()
        const organizations = yield* RayaTaskOrganization.make(
          database,
          RayaTask.make({ storage, database }),
          storage,
        ).list()
        expect(agents).toHaveLength(2)
        expect(agents.map((item) => item.enabled)).toEqual([true, true])
        expect(agents.map((item) => item.tools)).toEqual([
          ["inspect_team", "delegate_work"],
          ["read", "browser_*"],
        ])
        expect(organizations.items).toHaveLength(1)
        expect(organizations.items[0]?.delegations).toEqual([
          { senderID: agents[0]?.id, recipientID: agents[1]?.id, position: 0 },
        ])
        expect(organizations.items[0]?.members[1]?.supervisorID).toBe(agents[0]?.id)
        expect(
          yield* retry.execute(params, {
            ...context("create-company"),
            ask: () => Effect.die("completed creation must not request permission again"),
          }),
        ).toEqual(JSON.parse(JSON.stringify(recovered)))

        const conflict = yield* retry.execute({ ...params, purpose: "Different work" }, context("create-company"))
        expect(conflict.title).toBe("Routine change needs review")
        expect(conflict.metadata).toMatchObject({ requestStatus: "conflict" })
        expect(yield* RayaTask.make({ storage, database }).list()).toHaveLength(2)

        const parallel = {
          name: "Research",
          purpose: "Research markets every week.",
          workers: [
            {
              kind: "new" as const,
              key: "researcher",
              name: "Researcher",
              role: "Researcher",
              objective: "Research target markets",
              output: output("Research"),
              capabilities: [],
              access: "brief" as const,
              tools: ["read", "websearch", "webfetch"],
              when: "every Monday at 9am",
              timezone: "UTC",
            },
          ],
        }
        const raced = yield* Effect.all(
          [retry.execute(parallel, context("create-research")), retry.execute(parallel, context("create-research"))],
          { concurrency: 2 },
        )
        expect(raced.every((item) => item.title === "Organization created")).toBe(true)
        expect(yield* RayaTask.make({ storage, database }).list()).toHaveLength(3)
        expect(
          (yield* RayaTaskOrganization.make(database, RayaTask.make({ storage, database }), storage).list()).items,
        ).toHaveLength(2)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Storage.layerFromDir(path.join(directory, "storage")),
            Database.layerFromPath(path.join(directory, "queue.sqlite")),
          ),
        ),
      ),
    ),
  30_000,
)

it.live(
  "new organization workers remain paused until the graph is durable and recover activation",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const failed = { saves: 0 }
        const unreliable = {
          ...storage,
          replace: (key: string[], value: unknown) =>
            key[0] === "raya" && key[1] === "agent" && ++failed.saves === 3
              ? Effect.sync(() => {
                  throw new Error("simulated crash before worker activation")
                })
              : storage.replace(key, value),
        }
        const params = {
          name: "Friday Operations",
          purpose: "Coordinate the weekly close.",
          workers: [
            {
              kind: "new" as const,
              key: "chief",
              name: "Chief",
              role: "CEO",
              objective: "Coordinate the close",
              output: output("Close"),
              capabilities: [],
              access: "brief" as const,
              tools: ["inspect_team", "delegate_work"],
              when: "only when I ask",
              delegatesTo: ["books"],
            },
            {
              kind: "new" as const,
              key: "books",
              name: "Books",
              role: "Accountant",
              objective: "Review the books",
              output: output("Books"),
              capabilities: ["accounting"],
              access: "brief" as const,
              tools: ["read"],
              cron: "0 17 * * 5",
              timezone: "America/Toronto",
              supervisorKey: "chief",
            },
          ],
        }
        const broken = yield* (yield* routineManagementTools({ database, storage: unreliable, sessions }).create).init()
        expect(Exit.isFailure(yield* broken.execute(params, context("activate-company")).pipe(Effect.exit))).toBe(true)

        const tasks = RayaTask.make({ storage, database })
        const staged = yield* tasks.list()
        expect(staged).toHaveLength(2)
        expect(staged.every((item) => !item.enabled)).toBe(true)
        expect((yield* tasks.preview(Date.now())).every((item) => item.nextRun === undefined)).toBe(true)
        expect((yield* RayaTaskOrganization.make(database, tasks, storage).list()).items).toHaveLength(1)

        const retry = yield* (yield* routineManagementTools({ database, storage, sessions }).create).init()
        const chief = staged.find((item) => item.name === "Chief")
        if (!chief) throw new Error("staged chief was not found")
        yield* tasks.update(chief.id, { objective: "Changed while activation was interrupted" })
        const refused = yield* retry.execute(params, context("activate-company"))
        expect(refused).toMatchObject({
          title: "Organization creation needs review",
          metadata: { requestStatus: "unresolved" },
        })
        expect(refused.output).toContain("changed before activation")
        expect((yield* tasks.list()).every((item) => !item.enabled)).toBe(true)
        yield* tasks.update(chief.id, { objective: "Coordinate the close" })

        const recovered = yield* retry.execute(params, {
          ...context("activate-company"),
          ask: () => Effect.die("activation recovery must not request permission again"),
        })
        expect(recovered).toMatchObject({ title: "Organization created", metadata: { requestStatus: "complete" } })
        const active = yield* tasks.list()
        expect(active).toHaveLength(2)
        expect(active.every((item) => item.enabled)).toBe(true)
        expect((yield* tasks.preview(Date.now())).find((item) => item.name === "Books")?.nextRun).toBeNumber()
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Storage.layerFromDir(path.join(directory, "storage")),
            Database.layerFromPath(path.join(directory, "queue.sqlite")),
          ),
        ),
      ),
    ),
  30_000,
)

it.live(
  "main-chat organization recovery refuses a company changed after a lost result",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const failed = { value: false }
        const unreliable = {
          ...storage,
          replace: (key: string[], value: unknown) =>
            key[0] === "raya" &&
            key[1] === "agent-workflows" &&
            !failed.value &&
            value !== null &&
            typeof value === "object" &&
            "result" in value
              ? Effect.sync(() => {
                  failed.value = true
                  throw new Error("simulated crash after organization creation")
                })
              : storage.replace(key, value),
        }
        const params = {
          name: "Operations",
          purpose: "Run the company.",
          workers: [
            {
              kind: "new" as const,
              key: "chief",
              name: "Chief",
              role: "CEO",
              objective: "Run operations",
              output: output("Operations"),
              capabilities: [],
              access: "brief" as const,
              tools: ["inspect_team"],
              when: "only when I ask",
            },
          ],
        }
        const broken = yield* (yield* routineManagementTools({ database, storage: unreliable, sessions }).create).init()
        expect(Exit.isFailure(yield* broken.execute(params, context("changed-company")).pipe(Effect.exit))).toBe(true)

        const tasks = RayaTask.make({ storage, database })
        const organizations = RayaTaskOrganization.make(database, tasks, storage)
        const company = (yield* organizations.list()).items[0]
        if (!company) throw new Error("created company was not found")
        const changed = yield* organizations.update(company.id, {
          expectedRevision: company.revision,
          purpose: "Changed after creation.",
        })
        expect(changed.revision).toBe(2)

        const retry = yield* (yield* routineManagementTools({ database, storage, sessions }).create).init()
        const result = yield* retry.execute(params, {
          ...context("changed-company"),
          ask: () => Effect.die("recovery must not request permission again"),
        })
        expect(result).toMatchObject({
          title: "Organization creation needs review",
          metadata: {
            requestStatus: "conflict",
            view: "routines",
            organizationID: company.id,
            organizationRevision: 2,
          },
        })
        expect(result.output).toContain("changed before Raya could confirm creation")
        expect((yield* tasks.list()).filter((item) => item.name === "Chief")).toHaveLength(1)
        expect((yield* organizations.list()).items).toEqual([changed])
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Storage.layerFromDir(path.join(directory, "storage")),
            Database.layerFromPath(path.join(directory, "queue.sqlite")),
          ),
        ),
      ),
    ),
  30_000,
)

it.live(
  "authorized routine workers create bounded durable subordinates and recover lost results",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const tasks = RayaTask.make({ storage, database })
        const parent = yield* tasks.create({
          name: "Chief Designer",
          role: "designer",
          objective: "Lead website design",
          output: output("Design lead"),
          capabilities: ["design", "organization:provision"],
          access: "brief",
          tools: ["read", "inspect_team", "delegate_work"],
          schedule: { kind: "manual" },
        })
        const reviewer = yield* tasks.create({
          name: "Design Reviewer",
          role: "reviewer",
          objective: "Review website designs",
          output: output("Review"),
          capabilities: ["design"],
          access: "brief",
          schedule: { kind: "manual" },
        })
        const organizations = RayaTaskOrganization.make(database, tasks, storage)
        const organization = yield* organizations.create({
          name: "Website Builders",
          purpose: "Build client websites.",
          members: [
            { agentID: parent.id, role: "Chief Designer" },
            { agentID: reviewer.id, role: "Reviewer", supervisorID: parent.id },
          ],
          delegations: [{ senderID: parent.id, recipientID: reviewer.id }],
        })
        const runID = "run_design_lead"
        yield* tasks.record({
          id: runID,
          agentID: parent.id,
          at: Date.now(),
          sessionID: SessionID.make("ses_routine_management"),
          status: "running",
          scheduleVersion: 1,
          trigger: { kind: "manual" },
        })
        const workerSessions = {
          ...sessions,
          get: () =>
            Effect.succeed({
              metadata: {
                rayaRoutine: {
                  version: 1,
                  agentID: parent.id,
                  runID,
                  scheduleVersion: 1,
                  trigger: { kind: "manual" },
                },
              },
            } as never),
        }
        const params = {
          organizationID: organization.id,
          expectedRevision: organization.revision,
          name: "Landing Page Designer",
          role: "designer",
          objective: "Design one assigned landing page and return evidence",
          output: output("Landing page"),
          capabilities: ["design"],
          access: "brief" as const,
          tools: ["read"],
          when: "only when I ask",
          delegatesTo: [reviewer.id],
        }
        const failed = { pending: true }
        const unreliable = {
          ...storage,
          replace: (key: string[], value: unknown) =>
            key[1] === "agent-workflows" && failed.pending
              ? Effect.sync(() => {
                  failed.pending = false
                  throw new Error("simulated result loss")
                })
              : storage.replace(key, value),
        }
        const broken = routineManagementTools({ database, storage: unreliable, sessions: workerSessions })
        const provision = yield* (yield* broken.createSubordinate).init()
        expect(Exit.isFailure(yield* provision.execute(params, context("create-subordinate")).pipe(Effect.exit))).toBe(
          true,
        )

        const agents = yield* tasks.list()
        const child = agents.find((item) => item.name === params.name)
        if (!child) return yield* Effect.die(new Error("subordinate was not created"))
        expect(child).toMatchObject({
          role: "designer",
          access: "brief",
          capabilities: ["design"],
          tools: ["read"],
          schedule: { kind: "manual" },
        })
        const revised = yield* organizations.get(organization.id)
        expect(revised.revision).toBe(2)
        expect(revised.members.at(-1)).toMatchObject({ agentID: child.id, supervisorID: parent.id })
        expect(revised.delegations.slice(-2)).toEqual([
          { senderID: parent.id, recipientID: child.id, position: 1 },
          { senderID: child.id, recipientID: reviewer.id, position: 2 },
        ])

        const stable = routineManagementTools({ database, storage, sessions: workerSessions })
        const retry = yield* (yield* stable.createSubordinate).init()
        const recovered = yield* retry.execute(params, {
          ...context("create-subordinate"),
          ask: () => Effect.die("completed subordinate creation must not request permission again"),
        })
        expect(recovered).toMatchObject({
          title: "Subordinate created",
          metadata: { requestStatus: "complete", organizationRevision: 2, parentID: parent.id, agentID: child.id },
        })
        expect(yield* tasks.list()).toHaveLength(3)
        const inbox = RayaTaskInbox.make(database)
        const parentUpdates = (yield* inbox.page(parent.id)).messages.filter((item) => item.kind === "system")
        const childUpdates = (yield* inbox.page(child.id)).messages.filter((item) => item.kind === "system")
        expect(parentUpdates).toHaveLength(1)
        expect(parentUpdates[0]?.body).toContain(`${child.name} was added to ${organization.name}`)
        expect(childUpdates).toHaveLength(1)
        expect(childUpdates[0]?.body).toContain(`You were added to ${organization.name} by ${parent.name}`)

        const denied = yield* retry.execute(
          { ...params, expectedRevision: 2, name: "Growth Designer", capabilities: ["growth"] },
          context("excess-capability"),
        )
        expect(denied.title).toBe("Subordinate creation needs review")
        expect(denied.output).toContain("cannot grant the child capability growth")
        expect(yield* tasks.list()).toHaveLength(3)

        const deniedTool = yield* retry.execute(
          { ...params, expectedRevision: 2, name: "Shell Designer", tools: ["bash"] },
          context("excess-tool"),
        )
        expect(deniedTool.title).toBe("Subordinate creation needs review")
        expect(deniedTool.output).toContain("cannot grant the child tool pattern bash")
        expect(yield* tasks.list()).toHaveLength(3)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Storage.layerFromDir(path.join(directory, "storage")),
            Database.layerFromPath(path.join(directory, "queue.sqlite")),
          ),
        ),
      ),
    ),
  30_000,
)

it.live(
  "active routine workers delegate durable follow-on work through exact organization routes",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const tasks = RayaTask.make({ storage, database })
        const chief = yield* tasks.create({
          name: "Chief of Staff",
          role: "chief",
          objective: "Coordinate client work",
          output: output("Company"),
          capabilities: [],
          access: "full",
          schedule: { kind: "manual" },
        })
        const designer = yield* tasks.create({
          name: "Design Lead",
          role: "designer",
          objective: "Design assigned websites",
          output: output("Design"),
          capabilities: [],
          access: "full",
          schedule: { kind: "manual" },
        })
        const coder = yield* tasks.create({
          name: "Frontend Lead",
          role: "coder",
          objective: "Build approved website designs",
          output: output("Build"),
          capabilities: [],
          access: "full",
          schedule: { kind: "manual" },
        })
        const organizations = RayaTaskOrganization.make(database, tasks, storage)
        const organization = yield* organizations.create({
          name: "Website Builders",
          purpose: "Ship client websites.",
          members: [
            { agentID: chief.id, role: "Chief" },
            { agentID: designer.id, role: "Design", supervisorID: chief.id },
            { agentID: coder.id, role: "Frontend", supervisorID: designer.id },
          ],
          delegations: [
            { senderID: chief.id, recipientID: designer.id },
            { senderID: designer.id, recipientID: coder.id },
            { senderID: designer.id, recipientID: chief.id },
          ],
        })
        const errands = RayaTaskDelegation.make(database, organizations.authorize, organizations.shares)
        const incoming = yield* errands.admit(
          {
            source: "test:design-request",
            senderID: chief.id,
            recipientID: designer.id,
            organizationID: organization.id,
            organizationRevision: organization.revision,
            objective: "Design the approved client site",
          },
          chief,
          designer,
        )
        yield* errands.take(designer.id)
        const runID = "run_design_request"
        const sessionID = SessionID.make("ses_routine_management")
        yield* tasks.record({
          id: runID,
          agentID: designer.id,
          at: Date.now(),
          sessionID,
          status: "running",
          scheduleVersion: 1,
          trigger: { kind: "manual" },
        })
        yield* errands.attach(incoming.record.id, runID, sessionID)
        yield* tasks.record({
          id: "run_frontend_busy",
          agentID: coder.id,
          at: Date.now(),
          sessionID: SessionID.make("ses_frontend_busy"),
          status: "running",
          scheduleVersion: 1,
          trigger: { kind: "manual" },
        })
        const workerSessions = {
          ...sessions,
          get: () =>
            Effect.succeed({
              metadata: {
                rayaRoutine: {
                  version: 1,
                  agentID: designer.id,
                  runID,
                  scheduleVersion: 1,
                  trigger: { kind: "manual" },
                },
              },
            } as never),
        }
        const tools = routineManagementTools({ database, storage, sessions: workerSessions })
        const team = yield* tools.inspectTeam
        const inspect = yield* team.init()
        const visible = { ...inspect, id: team.id }
        expect(
          KiloToolRegistry.available(visible, {
            name: "build",
            mode: "primary",
            options: {},
            permission: {},
          } as Agent.Info),
        ).toBe(false)
        expect(
          KiloToolRegistry.available(visible, {
            name: "build",
            mode: "subagent",
            options: {},
            permission: {},
          } as Agent.Info),
        ).toBe(true)
        const inspected = yield* inspect.execute({}, context("inspect-team"))
        expect(inspected.title).toBe("Current Routine teams")
        expect(JSON.parse(inspected.output)).toMatchObject({
          worker: { agentID: designer.id, runID },
          organizations: [
            {
              id: organization.id,
              revision: organization.revision,
              role: "Design",
              members: [
                { agentID: chief.id, name: chief.name, canDelegate: true },
                { agentID: designer.id, name: designer.name, canDelegate: false },
                { agentID: coder.id, name: coder.name, canDelegate: true },
              ],
            },
          ],
          currentRequest: { id: incoming.record.id, senderID: chief.id, state: "running" },
        })
        const info = yield* tools.delegateWork
        const delegate = yield* info.init()
        const available = { ...delegate, id: info.id }
        expect(
          KiloToolRegistry.available(available, {
            name: "build",
            mode: "primary",
            options: {},
            permission: {},
          } as Agent.Info),
        ).toBe(false)
        expect(
          KiloToolRegistry.available(available, {
            name: "build",
            mode: "subagent",
            options: {},
            permission: {},
          } as Agent.Info),
        ).toBe(true)
        const params = {
          organizationID: organization.id,
          expectedRevision: organization.revision,
          recipientID: coder.id,
          objective: "Build the approved landing page",
          expected: "Return the deployed source and verification",
          context: "Use the approved design in the current request",
          deadline: Date.now() + 86_400_000,
          budget: 500,
        }
        const assigned = yield* delegate.execute(params, context("delegate-build"))
        expect(assigned).toMatchObject({
          title: "Work delegation saved",
          metadata: {
            requestStatus: "complete",
            state: "queued",
            senderID: designer.id,
            recipientID: coder.id,
            parentID: incoming.record.id,
            parentRunID: runID,
          },
        })
        const id = "delegationID" in assigned.metadata ? assigned.metadata.delegationID : undefined
        if (typeof id !== "string") return yield* Effect.die(new Error("delegation ID was not returned"))
        expect(yield* errands.get(id)).toMatchObject({
          senderID: designer.id,
          recipientID: coder.id,
          parentID: incoming.record.id,
          parentRunID: runID,
          organizationID: organization.id,
          organizationRevision: organization.revision,
          objective: params.objective,
          expected: params.expected,
          context: params.context,
          deadline: params.deadline,
          budget: params.budget,
          state: "queued",
        })
        expect(yield* delegate.execute(params, context("delegate-build"))).toEqual(assigned)
        expect(yield* errands.byRun(runID)).toHaveLength(1)

        const cycle = yield* delegate.execute(
          { ...params, recipientID: chief.id, objective: "Send the work back upstream" },
          context("delegate-cycle"),
        )
        expect(cycle.title).toBe("Work delegation needs review")
        expect(cycle.output).toContain("create a cycle")
        const stale = yield* delegate.execute(
          { ...params, expectedRevision: organization.revision + 1 },
          context("delegate-stale"),
        )
        expect(stale.title).toBe("Work delegation needs review")
        expect(stale.output).toContain("organization changed")
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Storage.layerFromDir(path.join(directory, "storage")),
            Database.layerFromPath(path.join(directory, "queue.sqlite")),
          ),
        ),
      ),
    ),
  30_000,
)

it.live(
  "main-chat updates require stable identities and replay their completed receipts",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const tasks = RayaTask.make({ storage, database })
        const agent = yield* tasks.create({
          name: "Accountant",
          role: "accountant",
          objective: "Review the books",
          output: output("Accounts"),
          capabilities: ["accounting"],
          access: "brief",
          tools: ["read"],
          schedule: { kind: "manual" },
        })
        const organizations = RayaTaskOrganization.make(database, tasks, storage)
        const organization = yield* organizations.create({
          name: "Finance",
          purpose: "Keep the company books current.",
          members: [{ agentID: agent.id, role: "Accountant" }],
        })
        const tools = routineManagementTools({ database, storage, sessions })
        const updateRoutine = yield* (yield* tools.updateRoutine).init()
        const routineParams = {
          agentID: agent.id,
          patch: {
            objective: "Review the books every week",
            tools: ["read", "websearch"],
            when: "every Friday at 5pm",
            timezone: "UTC",
          },
        }
        const changed = yield* updateRoutine.execute(routineParams, context("update-routine"))
        expect(changed.title).toBe("Routine updated")
        expect((yield* tasks.get(agent.id)).schedule).toEqual({ kind: "cron", expr: "0 17 * * 5", tz: "UTC" })
        expect((yield* tasks.get(agent.id)).tools).toEqual(["read", "websearch"])
        expect(
          yield* updateRoutine.execute(routineParams, {
            ...context("update-routine"),
            ask: () => Effect.die("completed routine update must not request permission again"),
          }),
        ).toEqual(JSON.parse(JSON.stringify(changed)))

        const stale = yield* updateRoutine.execute(
          { agentID: agent.id, patch: { tools: ["bash"] } },
          {
            ...context("stale-tool-update"),
            ask: () => tasks.update(agent.id, { tools: ["read", "webfetch"] }).pipe(Effect.asVoid),
          },
        )
        expect(stale.title).toBe("Routine update needs review")
        expect(stale.output).toContain("tool access changed")
        expect((yield* tasks.get(agent.id)).tools).toEqual(["read", "webfetch"])

        const authorityParams = { agentID: agent.id, patch: { canCreateWorkers: true } }
        const authorized = yield* updateRoutine.execute(authorityParams, context("grant-worker-creation"))
        expect(authorized.title).toBe("Routine updated")
        const granted = yield* tasks.get(agent.id)
        expect(granted.capabilities).toEqual(["accounting", "organization:provision"])
        expect(granted.provisioning).toMatchObject({
          enabled: true,
          source: "chat",
          actorID: "ses_routine_management",
        })
        expect(
          yield* updateRoutine.execute(authorityParams, {
            ...context("grant-worker-creation"),
            ask: () => Effect.die("completed authority update must not request permission again"),
          }),
        ).toEqual(JSON.parse(JSON.stringify(authorized)))

        const updateOrganization = yield* (yield* tools.updateOrganization).init()
        const organizationParams = {
          organizationID: organization.id,
          expectedRevision: organization.revision,
          purpose: "Keep the company books current and report every Friday.",
        }
        const revised = yield* updateOrganization.execute(organizationParams, context("update-organization"))
        expect(revised.title).toBe("Organization updated")
        expect((yield* organizations.get(organization.id)).revision).toBe(2)
        expect(
          yield* updateOrganization.execute(organizationParams, {
            ...context("update-organization"),
            ask: () => Effect.die("completed organization update must not request permission again"),
          }),
        ).toEqual(JSON.parse(JSON.stringify(revised)))

        const inspect = yield* (yield* tools.inspect).init()
        const listing = yield* inspect.execute({}, context("inspect"))
        expect(listing.output).toContain(agent.id)
        expect(listing.output).toContain(organization.id)

        const failed = { pending: true }
        const unreliable = {
          ...storage,
          replace: (key: string[], value: unknown) =>
            key[1] === "agent-workflows" && failed.pending
              ? Effect.sync(() => {
                  failed.pending = false
                  throw new Error("simulated update result loss")
                })
              : storage.replace(key, value),
        }
        const broken = routineManagementTools({ database, storage: unreliable, sessions })
        const interrupted = yield* (yield* broken.updateRoutine).init()
        const recoveryParams = { agentID: agent.id, patch: { name: "Weekly Accountant" } }
        expect(
          Exit.isFailure(
            yield* interrupted.execute(recoveryParams, context("recover-routine-update")).pipe(Effect.exit),
          ),
        ).toBe(true)
        const stamp = (yield* tasks.get(agent.id)).updatedAt
        const recovered = yield* updateRoutine.execute(recoveryParams, {
          ...context("recover-routine-update"),
          ask: () => Effect.die("a completed recovered update must not request permission again"),
        })
        expect(recovered.title).toBe("Routine updated")
        expect((yield* tasks.get(agent.id)).updatedAt).toBe(stamp)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Storage.layerFromDir(path.join(directory, "storage")),
            Database.layerFromPath(path.join(directory, "queue.sqlite")),
          ),
        ),
      ),
    ),
  30_000,
)

it.live(
  "routine company identity, conversations, authority and recovery survive service restart",
  () =>
    provideTmpdirInstance((root) =>
      Effect.gen(function* () {
        const services = () =>
          Layer.mergeAll(
            Storage.layerFromDir(path.join(root, "storage")),
            Database.layerFromPath(path.join(root, "queue.sqlite")),
          )
        const params = {
          name: "Continuity Company",
          purpose: "Keep a durable operating team.",
          workers: [
            {
              kind: "new" as const,
              key: "chief",
              name: "Chief of Staff",
              role: "CEO",
              objective: "Coordinate the company",
              output: output("Company"),
              capabilities: ["research"],
              canCreateWorkers: true,
              access: "brief" as const,
              tools: ["inspect_team", "delegate_work", "create_subordinate"],
              when: "only when I ask",
              delegatesTo: ["books"],
            },
            {
              kind: "new" as const,
              key: "books",
              name: "Books",
              role: "Accountant",
              objective: "Review the books",
              output: output("Accounts"),
              capabilities: ["accounting"],
              access: "brief" as const,
              tools: ["read"],
              when: "every Friday at 5pm",
              timezone: "America/Toronto",
              supervisorKey: "chief",
            },
          ],
        }
        const seeded = yield* Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.Service
            const database = yield* Database.Service
            const tasks = RayaTask.make({ storage, database })
            const organizations = RayaTaskOrganization.make(database, tasks, storage)
            const inbox = RayaTaskInbox.make(database)
            const create = yield* (yield* routineManagementTools({ database, storage, sessions }).create).init()
            const receipt = yield* create.execute(params, context("restart-company"))
            const agents = yield* tasks.list()
            const chief = agents.find((item) => item.name === "Chief of Staff")!
            const books = agents.find((item) => item.name === "Books")!
            const organization = (yield* organizations.list()).items[0]!
            const authorized = yield* tasks.authority(chief.id, { enabled: true, expected: true }, "user")
            const revised = yield* organizations.update(organization.id, {
              expectedRevision: organization.revision,
              purpose: "Keep a durable operating team and weekly books.",
            })
            const report = yield* inbox.publish({
              agentID: books.id,
              source: "report:restart-contract",
              kind: "report",
              body: "Friday close is ready.",
              occurrenceID: "occ_restart_contract",
              attachments: [
                {
                  id: "123e4567-e89b-42d3-a456-426614174001",
                  name: "close.txt",
                  mime: "text/plain",
                  size: 5,
                  data: "Y2xvc2U=",
                },
              ],
            })
            yield* inbox.read(books.id, report.time)
            yield* inbox.draft(books.id, { draft: "Ask about the reconciliation." })
            const run = yield* tasks.record({
              id: "occ_restart_contract",
              agentID: books.id,
              at: report.time,
              sessionID: SessionID.make("ses_restart_contract"),
              status: "complete",
              scheduleVersion: books.scheduleVersion,
              trigger: {
                kind: "timer",
                id: "occ_restart_contract",
                scheduledAt: report.time,
                observedAt: report.time,
              },
            })
            const conversation = (yield* inbox.summaries([books], new Map()))[0]!.conversationID
            return { receipt, chief: authorized, books, organization: revised, report, run, conversation }
          }).pipe(Effect.provide(services())),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage.Service
            const database = yield* Database.Service
            const tasks = RayaTask.make({ storage, database })
            const organizations = RayaTaskOrganization.make(database, tasks, storage)
            const inbox = RayaTaskInbox.make(database)
            const create = yield* (yield* routineManagementTools({ database, storage, sessions }).create).init()
            expect(
              yield* create.execute(params, {
                ...context("restart-company"),
                ask: () => Effect.die("a completed restarted request must not ask or mutate again"),
              }),
            ).toEqual(JSON.parse(JSON.stringify(seeded.receipt)))
            const agents = yield* tasks.list()
            expect(agents.map((item) => item.id).sort()).toEqual([seeded.chief.id, seeded.books.id].sort())
            expect(yield* tasks.get(seeded.chief.id)).toEqual(seeded.chief)
            expect((yield* tasks.get(seeded.books.id)).schedule).toEqual(seeded.books.schedule)
            expect(yield* organizations.get(seeded.organization.id)).toEqual(seeded.organization)
            expect((yield* tasks.runsFor(seeded.books.id))[0]).toEqual(seeded.run)
            const page = yield* inbox.page(seeded.books.id)
            expect(page.messages).toEqual([seeded.report])
            expect(yield* inbox.content(seeded.books.id, seeded.report.attachments![0]!.id)).toMatchObject({
              name: "close.txt",
              data: "Y2xvc2U=",
            })
            const box = (yield* inbox.summaries([seeded.books], new Map()))[0]!
            expect(box).toMatchObject({
              conversationID: seeded.conversation,
              unread: 0,
              draft: "Ask about the reconciliation.",
            })
          }).pipe(Effect.provide(services())),
        )
      }),
    ),
  30_000,
)
