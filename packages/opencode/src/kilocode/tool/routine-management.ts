import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import { english } from "@opencode-ai/core/kilocode/schedule"
import type { Database } from "@opencode-ai/core/database/database"
import { RayaTask } from "@/kilocode/task"
import {
  Create as OrganizationCreate,
  Organization,
  RayaTaskOrganization,
  Update as OrganizationUpdate,
} from "@/kilocode/task/organization"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import * as Tool from "@/tool/tool"
import { workflow } from "./workflow-request"

const Key = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/))
const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))
const Label = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(120))
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
  access: Schema.optional(Schema.Literals(["brief", "full"])),
  plan: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  schedule: Schema.optional(RayaTask.Schedule),
  expectedScheduleVersion: Schema.Int,
  expectedAccess: Schema.Literals(["brief", "full", "unset"]),
  expectedOutput: Schema.Union([RayaTask.Output, Schema.Literal("unset")]),
})
const RoutinePlan = Schema.Struct({ agent: RayaTask.Agent, patch: RoutineMutation })
const OrganizationUpdatePlan = Schema.Struct({
  before: Schema.Struct({ id: Schema.String, revision: Schema.Int }),
  patch: OrganizationUpdate,
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

export function routineManagementTools(input: {
  database: Database.Interface
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
}) {
  const tasks = RayaTask.make({ storage: input.storage, database: input.database })
  const organizations = RayaTaskOrganization.make(input.database, tasks, input.storage)

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
        "Create a durable organization and any new standing workers from the main chat. Before calling, use ask_options for every missing name, purpose, worker role/job, schedule and timezone, access level, capabilities, output acceptance criteria, supervisor, or directional delegation permission. Never infer authority from reporting lines. Existing workers require IDs from inspect_routines. New workers require a complete output contract.",
      parameters: CreateOrganization,
      execute: (params: typeof CreateOrganization.Type, ctx: Tool.Context) => {
        const patterns = [
          ...new Set(params.workers.map((item) => `access:${item.kind === "new" ? item.access : "existing"}`)),
          ...new Set(
            params.workers.flatMap((item) =>
              item.kind === "new" ? item.capabilities.map((value) => `capability:${value.toLowerCase()}`) : [],
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
                capabilities: [...item.capabilities],
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

  const updateRoutine = Tool.define(
    "update_routine",
    Effect.succeed({
      description:
        "Update one saved routine using its ID from inspect_routines. Use ask_options before calling if the requested role, job, schedule/timezone, access, capabilities, output criteria, or enable state is missing or ambiguous.",
      parameters: UpdateRoutine,
      execute: (params: typeof UpdateRoutine.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!Object.values(params.patch).some((value) => value !== undefined))
            return yield* Effect.fail(new Error("Describe at least one routine change."))
          if (params.patch.timezone !== undefined && params.patch.when === undefined && params.patch.cron === undefined)
            return yield* Effect.fail(new Error("Timezone requires a calendar schedule change."))
          const before = yield* tasks.get(params.agentID)
          const timed = params.patch.when !== undefined || params.patch.cron !== undefined
          const nextSchedule = timed ? yield* schedule(params.patch) : undefined
          const patch = yield* Schema.decodeUnknownEffect(RoutineMutation)({
            name: params.patch.name,
            role: params.patch.role,
            objective: params.patch.objective,
            output: params.patch.output,
            capabilities: params.patch.capabilities,
            access: params.patch.access,
            plan: params.patch.plan,
            enabled: params.patch.enabled,
            ...(nextSchedule ? { schedule: nextSchedule } : {}),
            expectedScheduleVersion: before.scheduleVersion ?? 1,
            expectedAccess: before.access ?? "unset",
            expectedOutput: before.output ?? "unset",
          })
          const patterns = [
            `access:${params.patch.access ?? before.access ?? "brief"}`,
            ...new Set(
              (params.patch.capabilities ?? before.capabilities).map((value) => `capability:${value.toLowerCase()}`),
            ),
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

  return { inspect, create, updateRoutine, updateOrganization }
}
