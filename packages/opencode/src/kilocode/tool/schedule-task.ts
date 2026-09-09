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

const Parameters = Schema.Struct({
  name: Schema.String,
  objective: Schema.String,
  output: Schema.optional(RayaTask.Output).annotate({
    description:
      "Define the deliverable in the run conversation and required criteria with stable IDs and explicit verification instructions. Ask for missing requirements rather than inventing acceptance.",
  }),
  role: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String).annotate({
    description: 'Plain English schedule such as "every weekday at 6pm", "once in 2 minutes", or "only when I ask".',
  }),
  cron: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String).annotate({
    description:
      "Required for calendar recurrence. Use the user's intended IANA timezone, such as America/Toronto or UTC; ask if it is unknown. Omit for delays, events and manual runs.",
  }),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  access: Schema.optional(Schema.Literals(["brief", "full"])).annotate({
    description:
      "Workspace access. Defaults to brief (read/notify). Use full only when the user has authorized workspace editing for this routine; a role or template is not authorization.",
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
        "Create a named standing agent with a role, a one-sentence job, and an optional schedule. Use this when the user assigns ongoing work to a specialist. Do not invent cron; pass when in plain English. Calendar recurrence requires the user's intended timezone; ask if unknown. Local scheduling requires Raya's backend to be running.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        request(
          input.storage,
          ctx,
          params,
          Effect.try({
            try: () => {
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
                `access:${params.access ?? "brief"}`,
                ...new Set((params.capabilities ?? []).map((value) => `capability:${value.toLowerCase()}`)),
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
                  access: params.access ?? "brief",
                  capabilities: params.capabilities ?? [],
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
                capabilities: params.capabilities ? [...params.capabilities] : undefined,
                access: params.access,
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
                (agent.output
                  ? ` Required output in the run conversation: ${agent.output.description}. Acceptance criteria: ${agent.output.criteria.map((item) => item.id).join(", ")}.`
                  : ""),
              metadata: {
                agentID: agent.id,
                runID,
                schedule: agent.schedule,
                enabled: agent.enabled,
                access: agent.access,
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
