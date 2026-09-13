import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import { english } from "@opencode-ai/core/kilocode/schedule"
import type { Database } from "@opencode-ai/core/database/database"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import {
  Create as OrganizationCreate,
  DelegationInput,
  MemberInput,
  Organization,
  RayaTaskOrganization,
  Update as OrganizationUpdate,
} from "@/kilocode/task/organization"
import { record as RoutineIdentity } from "@/kilocode/task/continuation"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import * as Tool from "@/tool/tool"
import { workflow } from "./workflow-request"

const Key = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/))
const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))
const Label = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(120))
const Provision = "organization:provision"
const ScheduleFields = {
  when: Schema.optional(Schema.String),
  cron: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
}
const Relations = {
  supervisorKey: Schema.optional(Key),
  delegatesTo: Schema.optional(Schema.Array(Key).check(Schema.isMaxLength(50))),
}
const Existing = Schema.Struct({
  kind: Schema.Literal("existing"),
  key: Key,
  agentID: Schema.String,
  role: Label,
  ...Relations,
})
const New = Schema.Struct({
  kind: Schema.Literal("new"),
  key: Key,
  name: Label,
  role: Label,
  objective: Text,
  output: RayaTask.Output,
  capabilities: Schema.Array(Schema.String),
  access: Schema.Literals(["brief", "full"]),
  plan: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  canCreateWorkers: Schema.optional(Schema.Boolean),
  ...ScheduleFields,
  ...Relations,
})
const CreateOrganization = Schema.Struct({
  name: Label,
  purpose: Text,
  workers: Schema.Array(Schema.Union([Existing, New])).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
})
const RoutinePatch = Schema.Struct({
  name: Schema.optional(Label),
  role: Schema.optional(Label),
  objective: Schema.optional(Text),
  output: Schema.optional(RayaTask.Output),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  canCreateWorkers: Schema.optional(Schema.Boolean),
  access: Schema.optional(Schema.Literals(["brief", "full"])),
  plan: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  ...ScheduleFields,
})
const UpdateRoutine = Schema.Struct({ agentID: Schema.String, patch: RoutinePatch })
const UpdateOrganization = Schema.Struct({
  organizationID: Schema.String,
  expectedRevision: Schema.Int,
  name: Schema.optional(Label),
  purpose: Schema.optional(Schema.Union([Text, Schema.Null])),
  members: Schema.optional(
    Schema.Array(Schema.Struct({ agentID: Schema.String, role: Label, supervisorID: Schema.optional(Schema.String) })),
  ),
  delegations: Schema.optional(Schema.Array(Schema.Struct({ senderID: Schema.String, recipientID: Schema.String }))),
})

const PlannedWorker = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("existing"), key: Key, id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("new"), key: Key, id: Schema.String, create: RayaTask.Create }),
])
const OrganizationPlan = Schema.Struct({
  id: Schema.String,
  workers: Schema.Array(PlannedWorker),
  create: OrganizationCreate,
})
const RoutineMutation = Schema.Struct({
  name: Schema.optional(Label),
  role: Schema.optional(Label),
  objective: Schema.optional(Schema.String),
  output: Schema.optional(RayaTask.Output),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  provisioning: Schema.optional(RayaTask.Provisioning),
  access: Schema.optional(Schema.Literals(["brief", "full"])),
  plan: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  schedule: Schema.optional(RayaTask.Schedule),
  expectedScheduleVersion: Schema.Int,
  expectedAccess: Schema.Literals(["brief", "full", "unset"]),
  expectedOutput: Schema.Union([RayaTask.Output, Schema.Literal("unset")]),
  expectedProvisioning: Schema.optional(Schema.Boolean),
})
const RoutinePlan = Schema.Struct({ agent: RayaTask.Agent, patch: RoutineMutation })
const OrganizationUpdatePlan = Schema.Struct({
  before: Schema.Struct({ id: Schema.String, revision: Schema.Int }),
  patch: OrganizationUpdate,
})
const CreateSubordinate = Schema.Struct({
  organizationID: Schema.String,
  expectedRevision: Schema.Int,
  name: Label,
  role: Label,
  objective: Text,
  output: RayaTask.Output,
  capabilities: Schema.Array(Schema.String),
  access: Schema.Literals(["brief", "full"]),
  plan: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  canCreateWorkers: Schema.optional(Schema.Boolean),
  delegatesTo: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(50))),
  ...ScheduleFields,
})
const DelegateWork = Schema.Struct({
  organizationID: Organization.fields.id,
  expectedRevision: Organization.fields.revision,
  recipientID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  objective: Text,
  expected: Schema.optional(Text),
  context: Schema.optional(Text),
  deadline: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8.64e15)),
  ),
  budget: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000))),
})
const SubordinatePlan = Schema.Struct({
  organizationID: Schema.String,
  expectedRevision: Schema.Int,
  parentID: Schema.String,
  childID: Schema.String,
  create: RayaTask.Create,
  members: Schema.Array(MemberInput),
  delegations: Schema.Array(DelegationInput),
})

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function uuid(value: string) {
  const hex = digest(value).slice(0, 32).split("")
  hex[12] = "4"
  hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`
}

function cyclic(key: string, parents: ReadonlyMap<string, string | undefined>, seen = new Set<string>()): boolean {
  if (seen.has(key)) return true
  const parent = parents.get(key)
  if (!parent) return false
  return cyclic(parent, parents, new Set(seen).add(key))
}

function schedule(input: { when?: string; cron?: string; timezone?: string }) {
  return Effect.try({
    try: () => {
      const value = input.cron ? { kind: "cron" as const, expr: input.cron } : english(input.when)
      if (value.kind !== "cron") {
        if (input.timezone !== undefined) throw new Error("Timezone is only used for calendar recurrence.")
        return value
      }
      const tz = input.timezone?.trim()
      if (!tz) throw new Error("Ask which timezone the user intends before saving a calendar routine.")
      return { ...value, tz }
    },
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  })
}

function organizationResult(item: typeof Organization.Type) {
  return {
    title: "Organization created",
    output: `Created ${item.name} with ${item.members.length} worker${item.members.length === 1 ? "" : "s"}. Open Routines to review its reporting lines, delegation permissions, schedules, access, and output requirements.`,
    metadata: {
      requestStatus: "complete",
      view: "routines",
      organizationID: item.id,
      organizationRevision: item.revision,
      agentIDs: item.members.map((member) => member.agentID),
    },
  }
}

function routineResult(agent: RayaTask.Agent, title = "Routine updated") {
  return {
    title,
    output: `${agent.name} now has the saved role, job, schedule, access, capabilities, and output requirements. Open Routines to review the assignment.`,
    metadata: { requestStatus: "complete", view: "routines", agentID: agent.id },
  }
}

function matches(agent: RayaTask.Agent, patch: typeof RoutineMutation.Type) {
  if (patch.name !== undefined && agent.name !== patch.name) return false
  if (patch.role !== undefined && agent.role !== patch.role) return false
  if (patch.objective !== undefined && agent.objective !== patch.objective) return false
  if (patch.output !== undefined && !isDeepStrictEqual(agent.output, patch.output)) return false
  if (patch.capabilities !== undefined && !isDeepStrictEqual(agent.capabilities, patch.capabilities)) return false
  if (patch.provisioning !== undefined && !isDeepStrictEqual(agent.provisioning, patch.provisioning)) return false
  if (patch.access !== undefined && agent.access !== patch.access) return false
  if (patch.plan !== undefined && agent.plan !== patch.plan) return false
  if (patch.enabled !== undefined && agent.enabled !== patch.enabled) return false
  if (patch.schedule !== undefined && !isDeepStrictEqual(agent.schedule, patch.schedule)) return false
  return true
}

function matchesOrganization(item: typeof Organization.Type, patch: typeof OrganizationUpdate.Type) {
  if (patch.name !== undefined && item.name !== patch.name) return false
  if (patch.purpose !== undefined && (item.purpose ?? null) !== patch.purpose) return false
  if (
    patch.members !== undefined &&
    !isDeepStrictEqual(
      item.members.map((member) => ({
        agentID: member.agentID,
        role: member.role,
        ...(member.supervisorID ? { supervisorID: member.supervisorID } : {}),
      })),
      patch.members,
    )
  )
    return false
  if (
    patch.delegations !== undefined &&
    !isDeepStrictEqual(
      item.delegations.map((edge) => ({ senderID: edge.senderID, recipientID: edge.recipientID })),
      patch.delegations,
    )
  )
    return false
  return true
}

function matchesWorker(agent: RayaTask.Agent, input: typeof RayaTask.Create.Type) {
  return (
    agent.name === input.name.trim() &&
    agent.role === (input.role ?? "generalist").trim() &&
    agent.objective === input.objective.trim() &&
    isDeepStrictEqual(agent.output, input.output) &&
    isDeepStrictEqual(agent.capabilities, input.capabilities ?? []) &&
    isDeepStrictEqual(agent.schedule, input.schedule) &&
    agent.access === (input.access ?? "brief") &&
    agent.enabled === (input.enabled ?? true) &&
    agent.plan === input.plan
  )
}

function subordinateResult(item: typeof Organization.Type, agent: RayaTask.Agent, parentID: string) {
  return {
    title: "Subordinate created",
    output: `Created ${agent.name} under its authorized worker in ${item.name}. The worker is durable, uses bounded access and capabilities, and can now receive delegated work.`,
    metadata: {
      requestStatus: "complete",
      view: "routines",
      organizationID: item.id,
      organizationRevision: item.revision,
      parentID,
      agentID: agent.id,
    },
  }
}

export function routineManagementTools(input: {
  database: Database.Interface
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
}) {
  const tasks = RayaTask.make({ storage: input.storage, database: input.database })
  const organizations = RayaTaskOrganization.make(input.database, tasks, input.storage)
  const inbox = RayaTaskInbox.make(input.database)
  const errands = RayaTaskDelegation.make(input.database, organizations.authorize, organizations.shares)
  const runner = RayaTaskRunner.make({ ...input, database: input.database })

  const announce = Effect.fn("RayaRoutineManagement.announceSubordinate")(function* (
    item: typeof Organization.Type,
    agent: RayaTask.Agent,
    plan: typeof SubordinatePlan.Type,
  ) {
    const parent = yield* tasks.get(plan.parentID)
    const abilities = agent.capabilities.length ? agent.capabilities.join(", ") : "none"
    const downstream = plan.delegations.filter((edge) => edge.senderID === agent.id).length
    const details = `${agent.role}; ${agent.access ?? "brief"} access; capabilities: ${abilities}; ${downstream} downstream delegation${downstream === 1 ? "" : "s"}.`
    const source = (target: "parent" | "child") =>
      `provision:${digest(JSON.stringify([item.id, agent.id, target])).slice(0, 48)}`
    yield* inbox.publish({
      agentID: parent.id,
      source: source("parent"),
      kind: "system",
      body: `${agent.name} was added to ${item.name} and reports to you. ${details}`,
    })
    yield* inbox.publish({
      agentID: agent.id,
      source: source("child"),
      kind: "system",
      body: `You were added to ${item.name} by ${parent.name} and report to ${parent.name}. ${details}`,
    })
  })

  const inspect = Tool.define(
    "inspect_routines",
    Effect.succeed({
      description:
        "List saved routines and active organizations before changing an existing assignment. Use the returned stable IDs and revisions with update_routine or update_organization.",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.all({ agents: tasks.list(), organizations: organizations.list({ limit: 50 }) }).pipe(
          Effect.map((result) => ({
            title: "Saved routines",
            output: JSON.stringify({
              routines: result.agents.map((agent) => ({
                id: agent.id,
                name: agent.name,
                role: agent.role,
                objective: agent.objective,
                schedule: agent.schedule,
                enabled: agent.enabled,
                access: agent.access,
                capabilities: agent.capabilities,
                canCreateWorkers: agent.capabilities.some((item) => item.toLowerCase() === Provision),
                updatedAt: agent.updatedAt,
              })),
              organizations: result.organizations.items.map((item) => ({
                id: item.id,
                name: item.name,
                purpose: item.purpose,
                revision: item.revision,
                members: item.members,
                delegations: item.delegations,
              })),
            }),
            metadata: { routineCount: result.agents.length, organizationCount: result.organizations.items.length },
          })),
          Effect.catch((err) =>
            Effect.succeed({
              title: "Routines unavailable",
              output: err instanceof Error ? err.message : String(err),
              metadata: { routineCount: 0, organizationCount: 0 },
            }),
          ),
        ),
    }),
  )

  const create = Tool.define(
    "create_organization",
    Effect.succeed({
      description:
        "Create a durable organization and any new standing workers from the main chat. Before calling, use ask_options for every missing name, purpose, worker role/job, schedule and timezone, access level, capabilities, output acceptance criteria, supervisor, directional delegation permission, or authority to create permanent subordinate workers. Never infer authority from reporting lines. Existing workers require IDs from inspect_routines. New workers require a complete output contract.",
      parameters: CreateOrganization,
      execute: (params: typeof CreateOrganization.Type, ctx: Tool.Context) => {
        const patterns = [
          ...new Set(params.workers.map((item) => `access:${item.kind === "new" ? item.access : "existing"}`)),
          ...new Set(
            params.workers.flatMap((item) =>
              item.kind === "new"
                ? [...item.capabilities, ...(item.canCreateWorkers ? [Provision] : [])].map(
                    (value) => `capability:${value.toLowerCase()}`,
                  )
                : [],
            ),
          ),
        ]
        return workflow({
          storage: input.storage,
          ctx,
          kind: "create_organization",
          params,
          prepare: Effect.gen(function* () {
            if (!ctx.callID) return yield* Effect.fail(new Error("Organization creation requires a stable tool call."))
            const keys = new Set(params.workers.map((item) => item.key))
            if (keys.size !== params.workers.length) return yield* Effect.fail(new Error("Worker keys must be unique."))
            const parents = new Map(params.workers.map((item) => [item.key, item.supervisorKey]))
            for (const item of params.workers) {
              if (item.kind === "new" && item.when === undefined && item.cron === undefined)
                return yield* Effect.fail(
                  new Error(`Ask when ${item.name} should run. Use "only when I ask" for a manual worker.`),
                )
              if (item.supervisorKey && !keys.has(item.supervisorKey))
                return yield* Effect.fail(
                  new Error(`Supervisor ${item.supervisorKey} is not a worker in this organization.`),
                )
              if (item.supervisorKey === item.key)
                return yield* Effect.fail(new Error(`${item.key} cannot supervise itself.`))
              if (new Set(item.delegatesTo ?? []).size !== (item.delegatesTo ?? []).length)
                return yield* Effect.fail(new Error(`${item.key} has a duplicate delegation permission.`))
              for (const key of item.delegatesTo ?? [])
                if (key === item.key) return yield* Effect.fail(new Error(`${item.key} cannot delegate to itself.`))
                else if (!keys.has(key))
                  return yield* Effect.fail(
                    new Error(`Delegation recipient ${key} is not a worker in this organization.`),
                  )
            }
            for (const item of params.workers) {
              if (cyclic(item.key, parents))
                return yield* Effect.fail(new Error("Organization reporting lines cannot contain a cycle."))
            }
            const seed = JSON.stringify([ctx.sessionID, ctx.messageID, ctx.callID])
            const workers: Array<typeof PlannedWorker.Type> = []
            for (const [index, item] of params.workers.entries()) {
              if (item.kind === "existing") {
                yield* tasks.get(item.agentID)
                workers.push({ kind: "existing", key: item.key, id: item.agentID })
                continue
              }
              const create = {
                name: item.name,
                role: item.role,
                objective: item.objective,
                output: item.output,
                capabilities: [...new Set([...item.capabilities, ...(item.canCreateWorkers ? [Provision] : [])])],
                access: item.access,
                schedule: yield* schedule(item),
                plan: item.plan,
                enabled: item.enabled,
              }
              yield* tasks.check(create)
              workers.push({
                kind: "new",
                key: item.key,
                id: uuid(`${seed}:worker:${index}`),
                create,
              })
            }
            const ids = new Map(workers.map((item) => [item.key, item.id]))
            return yield* Schema.decodeUnknownEffect(OrganizationPlan)({
              id: `org_${digest(`${seed}:organization`).slice(0, 32)}`,
              workers,
              create: {
                name: params.name,
                purpose: params.purpose,
                members: params.workers.map((item) => ({
                  agentID: ids.get(item.key)!,
                  role: item.role,
                  ...(item.supervisorKey ? { supervisorID: ids.get(item.supervisorKey)! } : {}),
                })),
                delegations: params.workers.flatMap((item) =>
                  (item.delegatesTo ?? []).map((key) => ({ senderID: ids.get(item.key)!, recipientID: ids.get(key)! })),
                ),
              },
            })
          }),
          decode: Schema.decodeUnknownEffect(OrganizationPlan),
          recover: (plan) =>
            organizations.get(plan.id).pipe(
              Effect.map(organizationResult),
              Effect.catchTag("RayaTaskOrganization.NotFound", () => Effect.succeed(undefined)),
            ),
          run: (plan) =>
            Effect.gen(function* () {
              yield* ctx.ask({ permission: "schedule_task", patterns, always: patterns, metadata: params })
              for (const worker of plan.workers) {
                if (worker.kind === "existing") {
                  yield* tasks.get(worker.id)
                  continue
                }
                yield* tasks.provision(worker.create, worker.id)
              }
              return organizationResult(yield* organizations.provision(plan.create, plan.id))
            }),
        }).pipe(
          Effect.catch((err) =>
            Effect.succeed({
              title: "Organization creation needs review",
              output: `${err instanceof Error ? err.message : String(err)} Review Routines before retrying this same request; do not create replacement workers.`,
              metadata: { requestStatus: "unresolved" },
            }),
          ),
        )
      },
    }),
  )

  const createSubordinate = Tool.define(
    "create_subordinate",
    Effect.succeed({
      description:
        "Create one durable subordinate inside the current routine worker's organization. The current worker must have the saved organization:provision capability. Use ask_options for every missing role, job, schedule/timezone, access, capabilities, output acceptance criteria, downstream delegation, or permission to let the child create workers. Child access and capabilities cannot exceed the current worker's saved authority.",
      parameters: CreateSubordinate,
      execute: (params: typeof CreateSubordinate.Type, ctx: Tool.Context) =>
        workflow({
          storage: input.storage,
          ctx,
          kind: "create_subordinate",
          params,
          prepare: Effect.gen(function* () {
            if (!ctx.callID) return yield* Effect.fail(new Error("Worker creation requires a stable tool call."))
            if (params.when === undefined && params.cron === undefined)
              return yield* Effect.fail(
                new Error(`Ask when ${params.name} should run. Use "only when I ask" for a manual worker.`),
              )
            const session = yield* input.sessions.get(ctx.sessionID)
            const identity = yield* Schema.decodeUnknownEffect(RoutineIdentity)(session.metadata?.rayaRoutine).pipe(
              Effect.mapError(() => new Error("Only a running routine worker can create a subordinate.")),
            )
            const parent = yield* tasks.get(identity.agentID)
            const run = (yield* tasks.runsFor(parent.id)).find(
              (item) =>
                item.id === identity.runID &&
                item.sessionID === ctx.sessionID &&
                item.scheduleVersion === identity.scheduleVersion &&
                RayaTask.pending(item),
            )
            if (!run) return yield* Effect.fail(new Error("The current routine run is no longer active."))
            const authority = new Set(parent.capabilities.map((item) => item.toLowerCase()))
            if (!authority.has(Provision))
              return yield* Effect.fail(
                new Error("This worker does not have saved authority to create permanent organization workers."),
              )
            if (params.access === "full" && parent.access !== "full")
              return yield* Effect.fail(new Error("A read-only worker cannot create a worker with editing access."))
            const requested = [...params.capabilities, ...(params.canCreateWorkers ? [Provision] : [])]
            const capabilities = [...new Set(requested)]
            const excess = capabilities.find((item) => !authority.has(item.toLowerCase()))
            if (excess)
              return yield* Effect.fail(
                new Error(
                  `The current worker cannot grant the child capability ${excess}; ask the user to update its authority.`,
                ),
              )
            const organization = yield* organizations.get(params.organizationID)
            if (organization.archived) return yield* Effect.fail(new Error("This organization is archived."))
            if (organization.revision !== params.expectedRevision)
              return yield* Effect.fail(new Error("This organization changed. Reload it before creating a worker."))
            if (organization.members.length >= 50)
              return yield* Effect.fail(new Error("This organization already has the maximum of 50 workers."))
            if (!organization.members.some((item) => item.agentID === parent.id))
              return yield* Effect.fail(new Error("The current worker is not an active member of this organization."))
            const recipients = params.delegatesTo ?? []
            if (new Set(recipients).size !== recipients.length)
              return yield* Effect.fail(new Error("A downstream worker can only be listed once."))
            const members = new Set(organization.members.map((item) => item.agentID))
            const allowed = new Set(
              organization.delegations.filter((item) => item.senderID === parent.id).map((item) => item.recipientID),
            )
            for (const id of recipients) {
              if (!members.has(id))
                return yield* Effect.fail(new Error(`Delegation recipient ${id} is not in this organization.`))
              if (!allowed.has(id))
                return yield* Effect.fail(
                  new Error(`The current worker cannot grant delegation authority to ${id} that it does not have.`),
                )
            }
            const create = {
              name: params.name,
              role: params.role,
              objective: params.objective,
              output: params.output,
              capabilities,
              access: params.access,
              schedule: yield* schedule(params),
              plan: params.plan,
              enabled: params.enabled,
            }
            yield* tasks.check(create)
            const seed = JSON.stringify([ctx.sessionID, ctx.messageID, ctx.callID, parent.id, organization.id])
            const childID = uuid(`${seed}:subordinate`)
            return yield* Schema.decodeUnknownEffect(SubordinatePlan)({
              organizationID: organization.id,
              expectedRevision: organization.revision,
              parentID: parent.id,
              childID,
              create,
              members: [
                ...organization.members.map((item) => ({
                  agentID: item.agentID,
                  role: item.role,
                  ...(item.supervisorID ? { supervisorID: item.supervisorID } : {}),
                })),
                { agentID: childID, role: params.role, supervisorID: parent.id },
              ],
              delegations: [
                ...organization.delegations.map((item) => ({
                  senderID: item.senderID,
                  recipientID: item.recipientID,
                })),
                { senderID: parent.id, recipientID: childID },
                ...recipients.map((recipientID) => ({ senderID: childID, recipientID })),
              ],
            })
          }),
          decode: Schema.decodeUnknownEffect(SubordinatePlan),
          recover: (plan) =>
            Effect.gen(function* () {
              const organization = yield* organizations.get(plan.organizationID)
              if (organization.revision === plan.expectedRevision) return undefined
              const member = organization.members.some((item) => item.agentID === plan.childID)
              if (organization.revision === plan.expectedRevision + 1 && member) {
                const agent = yield* tasks.get(plan.childID)
                if (
                  matchesWorker(agent, plan.create) &&
                  matchesOrganization(organization, {
                    expectedRevision: plan.expectedRevision,
                    members: plan.members,
                    delegations: plan.delegations,
                  })
                ) {
                  yield* announce(organization, agent, plan)
                  return subordinateResult(organization, agent, plan.parentID)
                }
              }
              return {
                title: "Subordinate creation needs review",
                output:
                  "The organization changed after this worker saved its creation plan. Review Routines before changing the organization again.",
                metadata: { requestStatus: "conflict", view: "routines", organizationID: organization.id },
              }
            }),
          run: (plan) =>
            ctx
              .ask({
                permission: "create_subordinate",
                patterns: [
                  `organization:${plan.organizationID}`,
                  `access:${plan.create.access ?? "brief"}`,
                  ...(plan.create.capabilities ?? []).map((item) => `capability:${item.toLowerCase()}`),
                ],
                always: [`organization:${plan.organizationID}`],
                metadata: params,
              })
              .pipe(
                Effect.andThen(tasks.provision(plan.create, plan.childID)),
                Effect.flatMap((agent) =>
                  organizations
                    .update(plan.organizationID, {
                      expectedRevision: plan.expectedRevision,
                      members: plan.members,
                      delegations: plan.delegations,
                    })
                    .pipe(
                      Effect.tap((organization) => announce(organization, agent, plan)),
                      Effect.map((organization) => subordinateResult(organization, agent, plan.parentID)),
                    ),
                ),
              ),
        }).pipe(
          Effect.catch((err) =>
            Effect.succeed({
              title: "Subordinate creation needs review",
              output: `${err instanceof Error ? err.message : String(err)} Review Routines before retrying this same request; do not create a replacement worker.`,
              metadata: { requestStatus: "unresolved" },
            }),
          ),
        ),
    }),
  )

  const delegateWork = Tool.define(
    "delegate_work",
    Effect.succeed({
      description:
        "Assign one bounded follow-on request to an existing worker through the current organization. Use ask_options before calling if the responsible worker, outcome, expected result, context, deadline, or budget is ambiguous. The recipient must be on an exact saved outgoing delegation route. This tool saves and starts the request when possible; it never returns a worker result that has not arrived.",
      parameters: DelegateWork,
      execute: (params: typeof DelegateWork.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!ctx.callID) return yield* Effect.fail(new Error("Work delegation requires a stable tool call."))
          const session = yield* input.sessions.get(ctx.sessionID)
          const identity = yield* Schema.decodeUnknownEffect(RoutineIdentity)(session.metadata?.rayaRoutine).pipe(
            Effect.mapError(() => new Error("Only a running routine worker can delegate work.")),
          )
          const sender = yield* tasks.get(identity.agentID)
          const run = (yield* tasks.runsFor(sender.id)).find(
            (item) =>
              item.id === identity.runID &&
              item.sessionID === ctx.sessionID &&
              item.scheduleVersion === identity.scheduleVersion &&
              isDeepStrictEqual(item.trigger, identity.trigger) &&
              RayaTask.pending(item),
          )
          if (!run) return yield* Effect.fail(new Error("The current routine run is no longer active."))
          const organization = yield* organizations.get(params.organizationID)
          if (organization.archived) return yield* Effect.fail(new Error("This organization is archived."))
          if (organization.revision !== params.expectedRevision)
            return yield* Effect.fail(new Error("This organization changed. Reload it before delegating work."))
          if (!organization.members.some((item) => item.agentID === sender.id))
            return yield* Effect.fail(new Error("The current worker is not an active member of this organization."))
          if (!organization.members.some((item) => item.agentID === params.recipientID))
            return yield* Effect.fail(new Error("The receiving worker is not an active member of this organization."))
          if (
            !organization.delegations.some(
              (item) => item.senderID === sender.id && item.recipientID === params.recipientID,
            )
          )
            return yield* Effect.fail(
              new Error("This organization does not permit the current worker to delegate to that worker."),
            )
          const incoming = yield* errands.bySession(ctx.sessionID)
          if (
            incoming &&
            (incoming.recipientID !== sender.id ||
              incoming.childRunID !== run.id ||
              incoming.organizationID !== organization.id ||
              (incoming.state !== "running" && incoming.state !== "needs_input"))
          )
            return yield* Effect.fail(new Error("The current delegated request no longer matches this worker run."))
          if (incoming) {
            const tree = yield* errands.tree(incoming.id)
            const ancestry = new Set(tree.above.flatMap((item) => [item.senderID, item.recipientID]))
            ancestry.add(tree.record.senderID)
            ancestry.add(tree.record.recipientID)
            if (ancestry.has(params.recipientID))
              return yield* Effect.fail(new Error("This delegation would create a cycle in the current work chain."))
          }
          const source = `delegate:${digest(
            JSON.stringify([ctx.sessionID, ctx.messageID, ctx.callID, sender.id, organization.id]),
          ).slice(0, 48)}`
          const request = {
            source,
            senderID: sender.id,
            recipientID: params.recipientID,
            parentID: incoming?.id,
            parentRunID: run.id,
            organizationID: organization.id,
            organizationRevision: organization.revision,
            objective: params.objective.trim(),
            expected: params.expected?.trim(),
            context: params.context?.trim(),
            deadline: params.deadline,
            budget: params.budget,
          }
          const record = yield* runner.delegate(request)
          if (
            record.source !== source ||
            record.senderID !== sender.id ||
            record.recipientID !== params.recipientID ||
            record.parentID !== incoming?.id ||
            record.parentRunID !== run.id ||
            record.organizationID !== organization.id ||
            record.organizationRevision !== organization.revision ||
            record.objective !== params.objective.trim() ||
            record.expected !== params.expected?.trim() ||
            record.context !== params.context?.trim() ||
            record.deadline !== params.deadline ||
            record.budget !== params.budget
          )
            return yield* Effect.fail(new Error("The saved delegation does not match this request."))
          const recipient = yield* tasks.get(record.recipientID)
          const reason = record.reason ? ` ${record.reason}` : ""
          return {
            title: "Work delegation saved",
            output: `Assigned the request to ${recipient.name}. Saved state: ${record.state}.${reason}`,
            metadata: {
              requestStatus: record.state === "failed" || record.state === "cancelled" ? "unresolved" : "complete",
              view: "routines",
              organizationID: organization.id,
              organizationRevision: organization.revision,
              delegationID: record.id,
              state: record.state,
              senderID: record.senderID,
              recipientID: record.recipientID,
              parentID: record.parentID,
              parentRunID: record.parentRunID,
            },
          }
        }).pipe(
          Effect.catch((err) =>
            Effect.succeed({
              title: "Work delegation needs review",
              output: `${err instanceof Error ? err.message : String(err)} Review the current organization and work chain before retrying.`,
              metadata: { requestStatus: "unresolved", view: "routines", organizationID: params.organizationID },
            }),
          ),
        ),
    }),
  )

  const updateRoutine = Tool.define(
    "update_routine",
    Effect.succeed({
      description:
        "Update one saved routine using its ID from inspect_routines. Use ask_options before calling if the requested role, job, schedule/timezone, access, capabilities, worker-creation authority, output criteria, or enable state is missing or ambiguous.",
      parameters: UpdateRoutine,
      execute: (params: typeof UpdateRoutine.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!Object.values(params.patch).some((value) => value !== undefined))
            return yield* Effect.fail(new Error("Describe at least one routine change."))
          if (params.patch.timezone !== undefined && params.patch.when === undefined && params.patch.cron === undefined)
            return yield* Effect.fail(new Error("Timezone requires a calendar schedule change."))
          const before = yield* tasks.get(params.agentID)
          const allowed = before.capabilities.some((item) => item.toLowerCase() === Provision)
          const base = params.patch.capabilities ?? before.capabilities
          const capabilities =
            params.patch.canCreateWorkers === undefined
              ? params.patch.capabilities
              : params.patch.canCreateWorkers
                ? [...base.filter((item) => item.toLowerCase() !== Provision), Provision]
                : base.filter((item) => item.toLowerCase() !== Provision)
          const provisioning =
            params.patch.canCreateWorkers === undefined
              ? undefined
              : {
                  enabled: params.patch.canCreateWorkers,
                  source: "chat" as const,
                  actorID: ctx.sessionID,
                  changedAt: Date.now(),
                }
          const timed = params.patch.when !== undefined || params.patch.cron !== undefined
          const nextSchedule = timed ? yield* schedule(params.patch) : undefined
          const patch = yield* Schema.decodeUnknownEffect(RoutineMutation)({
            name: params.patch.name,
            role: params.patch.role,
            objective: params.patch.objective,
            output: params.patch.output,
            capabilities,
            provisioning,
            access: params.patch.access,
            plan: params.patch.plan,
            enabled: params.patch.enabled,
            ...(nextSchedule ? { schedule: nextSchedule } : {}),
            expectedScheduleVersion: before.scheduleVersion ?? 1,
            expectedAccess: before.access ?? "unset",
            expectedOutput: before.output ?? "unset",
            expectedProvisioning: allowed,
          })
          const patterns = [
            `access:${params.patch.access ?? before.access ?? "brief"}`,
            ...new Set((capabilities ?? before.capabilities).map((value) => `capability:${value.toLowerCase()}`)),
          ]
          return yield* workflow({
            storage: input.storage,
            ctx,
            kind: "update_routine",
            params,
            prepare: Schema.decodeUnknownEffect(RoutinePlan)({ agent: before, patch }),
            decode: Schema.decodeUnknownEffect(RoutinePlan),
            recover: (plan) =>
              tasks.get(plan.agent.id).pipe(
                Effect.map((current) => {
                  if (matches(current, plan.patch)) return routineResult(current)
                  if (current.updatedAt === plan.agent.updatedAt) return undefined
                  return {
                    title: "Routine update needs review",
                    output:
                      "This routine changed after the saved update plan. Review its current assignment before editing again.",
                    metadata: { requestStatus: "conflict", view: "routines", agentID: current.id },
                  }
                }),
              ),
            run: (plan) =>
              ctx.ask({ permission: "schedule_task", patterns, always: patterns, metadata: params }).pipe(
                Effect.andThen(tasks.update(plan.agent.id, plan.patch)),
                Effect.map((agent) => routineResult(agent)),
              ),
          })
        }).pipe(
          Effect.catch((err) =>
            Effect.succeed({
              title: "Routine update needs review",
              output: `${err instanceof Error ? err.message : String(err)} Review the saved routine before making another change.`,
              metadata: { requestStatus: "unresolved" },
            }),
          ),
        ),
    }),
  )

  const updateOrganization = Tool.define(
    "update_organization",
    Effect.succeed({
      description:
        "Update an active organization's name, purpose, membership, reporting lines, or directional delegation permissions. Use its ID and current revision from inspect_routines. Ask with ask_options whenever membership, roles, supervisor relationships, or delegation authority is ambiguous. Reporting lines never imply delegation permission.",
      parameters: UpdateOrganization,
      execute: (params: typeof UpdateOrganization.Type, ctx: Tool.Context) =>
        workflow({
          storage: input.storage,
          ctx,
          kind: "update_organization",
          params,
          prepare: organizations.get(params.organizationID).pipe(
            Effect.flatMap((before) =>
              before.revision === params.expectedRevision
                ? Schema.decodeUnknownEffect(OrganizationUpdatePlan)({
                    before: { id: before.id, revision: before.revision },
                    patch: {
                      expectedRevision: params.expectedRevision,
                      name: params.name,
                      purpose: params.purpose,
                      members: params.members,
                      delegations: params.delegations,
                    },
                  })
                : Effect.fail(new Error("This organization changed. Run inspect_routines before editing it.")),
            ),
          ),
          decode: Schema.decodeUnknownEffect(OrganizationUpdatePlan),
          recover: (plan) =>
            organizations.get(plan.before.id).pipe(
              Effect.map((current) => {
                if (current.revision === plan.before.revision + 1 && matchesOrganization(current, plan.patch))
                  return {
                    title: "Organization updated",
                    output: `Updated ${current.name}. Open Routines to review revision ${current.revision}.`,
                    metadata: {
                      requestStatus: "complete",
                      view: "routines",
                      organizationID: current.id,
                      organizationRevision: current.revision,
                    },
                  }
                if (current.revision === plan.before.revision) return undefined
                return {
                  title: "Organization update needs review",
                  output: "This organization changed after the saved update plan. Inspect it before editing again.",
                  metadata: { requestStatus: "conflict", view: "routines", organizationID: current.id },
                }
              }),
            ),
          run: (plan) =>
            ctx
              .ask({
                permission: "schedule_task",
                patterns: ["organization:update"],
                always: ["organization:update"],
                metadata: params,
              })
              .pipe(
                Effect.andThen(organizations.update(plan.before.id, plan.patch)),
                Effect.map((item) => ({
                  title: "Organization updated",
                  output: `Updated ${item.name}. Open Routines to review revision ${item.revision}.`,
                  metadata: {
                    requestStatus: "complete",
                    view: "routines",
                    organizationID: item.id,
                    organizationRevision: item.revision,
                  },
                })),
              ),
        }).pipe(
          Effect.catch((err) =>
            Effect.succeed({
              title: "Organization update needs review",
              output: `${err instanceof Error ? err.message : String(err)} Review the organization before making another change.`,
              metadata: { requestStatus: "unresolved" },
            }),
          ),
        ),
    }),
  )

  return { inspect, create, createSubordinate, delegateWork, updateRoutine, updateOrganization }
}
