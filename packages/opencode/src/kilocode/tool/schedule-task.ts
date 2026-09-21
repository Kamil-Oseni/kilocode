import { english } from "@opencode-ai/core/kilocode/schedule"
export { english } from "@opencode-ai/core/kilocode/schedule"
import { Cause, Effect, Exit, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { inspect } from "@/kilocode/task/recovery"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import type { Database } from "@opencode-ai/core/database/database"
import { request } from "./schedule-request"

const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))
const Label = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(120))
const ToolName = Schema.String.check(Schema.isPattern(/^\S+$/), Schema.isMaxLength(128))
const Tools = Schema.Array(ToolName).check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value) => (new Set(value).size === value.length ? undefined : "Tool patterns must be unique.")),
)
const Parameters = Schema.Struct({
  name: Label,
  objective: Text,
  output: RayaTask.Output.annotate({
    description:
      "Define the deliverable in the run conversation and required criteria with stable IDs and explicit verification instructions. Ask for missing requirements rather than inventing acceptance.",
  }),
  role: Label.annotate({
    description: "The worker's explicit job role. Ask the user when the intended role is unclear.",
  }),
  when: Schema.optional(Schema.String).annotate({
    description: 'Plain English schedule such as "every weekday at 6pm", "once in 2 minutes", or "only when I ask".',
  }),
  cron: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String).annotate({
    description:
      "Required for calendar recurrence. Use the user's intended IANA timezone, such as America/Toronto or UTC; ask if it is unknown. Omit for delays, events and manual runs.",
  }),
  capabilities: Schema.Array(Schema.String).annotate({
    description: "Explicit extra capabilities. Pass [] only when the user chooses none.",
  }),
  access: Schema.Literals(["brief", "full"]).annotate({
    description:
      "Workspace access. Use brief for read/notify or full only when the user authorizes editing; a role or template is not authorization.",
  }),
  tools: Tools.annotate({
    description:
      'The exact tool patterns the worker may use. Pass ["*"] only when the user explicitly chooses all tools and [] only when the user chooses question-only access.',
  }),
  budget: Schema.optional(RayaTask.RunBudget).annotate({
    description:
      "Optional maximum model cost in USD for each run. Ask the user to choose a positive amount or explicitly choose no saved limit.",
  }),
  plan: Schema.optional(Schema.String),
  runNow: Schema.optional(Schema.Boolean),
})

export function scheduleTaskTool(input: {
  database: Database.Interface
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
}) {
  const runner = RayaTaskRunner.make(input)
  return Tool.define(
    "schedule_task",
    Effect.succeed({
      description:
        'Create one durable standing agent from main chat after its assignment is fully reviewed. Before calling, use ask_options for every missing name, role, job, schedule and timezone, read/notify or editing access, exact tool scope, capabilities, output description, acceptance criterion, and per-run model-cost ceiling or an explicit choice of no saved limit. Pass ["*"] only for an explicit all-tools choice and [] only for question-only access. Use "only when I ask" for a manual worker. Do not invent cron or a spending limit. Local scheduling requires Raya\'s backend to be running.',
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        request(
          input.storage,
          ctx,
          params,
          Effect.try({
            try: () => {
              if ((params.when === undefined) === (params.cron === undefined))
                throw new Error(
                  'Ask when this routine should run. Provide either a plain-English schedule such as "only when I ask" or one cron expression, but not both.',
                )
              const schedule = params.cron ? { kind: "cron" as const, expr: params.cron } : english(params.when)
              if (schedule.kind !== "cron") {
                if (params.timezone !== undefined)
                  throw new Error(
                    "Timezone is only used for calendar recurrence. Omit it for delays, events and manual runs.",
                  )
                return schedule
              }
              const tz = params.timezone?.trim()
              if (!tz)
                throw new Error(
                  "Choose the intended timezone before creating a calendar routine, for example America/Toronto or UTC.",
                )
              return { ...schedule, tz }
            },
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(
            Effect.tap((schedule) => {
              const patterns = [
                `access:${params.access}`,
                ...new Set(params.capabilities.map((value) => `capability:${value.toLowerCase()}`)),
                ...params.tools.map((value) => `tool:${value}`),
              ]
              return ctx.ask({
                permission: "schedule_task",
                patterns,
                always: patterns,
                metadata: {
                  name: params.name,
                  objective: params.objective,
                  output: params.output,
                  role: params.role,
                  access: params.access,
                  capabilities: params.capabilities,
                  tools: params.tools,
                  budget: params.budget,
                  schedule,
                  plan: params.plan,
                  runNow: params.runNow ?? false,
                },
              })
            }),
            Effect.flatMap((schedule) =>
              runner.tasks.create({
                name: params.name,
                role: params.role,
                objective: params.objective,
                output: params.output,
                capabilities: [...params.capabilities],
                access: params.access,
                tools: [...params.tools],
                budget: params.budget,
                schedule,
                plan: params.plan,
              }),
            ),
            Effect.flatMap((agent) =>
              Effect.gen(function* () {
                if (!params.runNow)
                  return {
                    agent,
                    run: undefined as RayaTask.Run | undefined,
                    review: false,
                    runID: undefined as string | undefined,
                  }
                const result = yield* runner.fire(agent.id).pipe(Effect.exit)
                if (Exit.isSuccess(result)) return { agent, run: result.value, review: false, runID: result.value.id }
                if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause).pipe(Effect.orDie)
                const claim = yield* inspect(input.storage, agent.id)
                return {
                  agent,
                  run: undefined,
                  review: true,
                  runID: claim && "runID" in claim ? claim.runID : undefined,
                }
              }),
            ),
            Effect.map(({ agent, run, review, runID }) => ({
              title: review ? "Routine saved; startup needs review" : "Agent assigned",
              output:
                (review
                  ? `Saved ${agent.name} (${agent.role}). Immediate startup could not be confirmed. Review this routine in Routines before retrying; do not create a replacement routine.`
                  : run
                    ? `Assigned ${agent.name} (${agent.role}) and started a background run.`
                    : `Assigned ${agent.name} (${agent.role}). ${agent.enabled ? "Enabled" : "Paused"}.`) +
                (agent.schedule.kind === "cron"
                  ? ` Calendar: ${agent.schedule.expr}, timezone ${agent.schedule.tz}. Raya's backend must be running for scheduled work.`
                  : " Review the schedule in Routines.") +
                ` Workspace access: ${agent.access === "full" ? "editing allowed" : "read/notify"}.` +
                ` Tool scope: ${agent.tools?.length ? agent.tools.join(", ") : "questions only"}.` +
                ` Per-run model-cost limit: ${agent.budget === undefined ? "none saved" : `$${agent.budget}`}.` +
                ` Required output in the run conversation: ${params.output.description}. Acceptance criteria: ${params.output.criteria.map((item) => item.id).join(", ")}.`,
              metadata: {
                view: "routines",
                agentID: agent.id,
                runID,
                schedule: agent.schedule,
                enabled: agent.enabled,
                access: agent.access,
                capabilities: agent.capabilities,
                tools: agent.tools,
                budget: agent.budget,
                output: agent.output,
                startup: review ? "review" : run ? "started" : "not-requested",
              },
            })),
            Effect.catch((err) =>
              Effect.succeed({
                title: "Agent not created",
                output: err instanceof Error ? err.message : String(err),
                metadata: {},
              }),
            ),
          ),
        ),
    }),
  )
}
