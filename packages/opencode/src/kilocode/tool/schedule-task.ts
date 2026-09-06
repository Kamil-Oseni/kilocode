import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"

const Parameters = Schema.Struct({
  name: Schema.String,
  objective: Schema.String,
  role: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String).annotate({
    description: 'Plain English schedule such as "every weekday at 6pm", "once in 2 minutes", or "only when I ask".',
  }),
  cron: Schema.optional(Schema.String),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  plan: Schema.optional(Schema.String),
  runNow: Schema.optional(Schema.Boolean),
})

export function english(when: string | undefined): RayaTask.Schedule {
  const text = (when ?? "").trim().toLowerCase()
  if (!text || /when i ask|manual|just when/i.test(text)) return { kind: "manual" }
  const once = text.match(/in (\d+)\s*(minute|min|hour|hr)s?/)
  if (once) {
    const n = Number(once[1])
    const ms = once[2]!.startsWith("h") ? n * 3_600_000 : n * 60_000
    return { kind: "once", at: Date.now() + ms }
  }
  if (/ci fail|github action|when ci fails/.test(text)) {
    const branch = text.match(/on ([a-z0-9._/-]+)/i)?.[1]
    return { kind: "event", source: "ci", filter: branch === "main" || branch === "master" ? branch : undefined }
  }
  const hour = text.match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
  const weekday = /weekday|monday|tue|wed|thu|fri/.test(text)
  if (hour) {
    let h = Number(hour[1])
    const m = Number(hour[2] ?? "0")
    const ap = hour[3]
    if (ap === "pm" && h < 12) h += 12
    if (ap === "am" && h === 12) h = 0
    return { kind: "cron", expr: `${m} ${h} * * ${weekday ? "1-5" : "*"}` }
  }
  if (/every morning|daily/.test(text)) return { kind: "cron", expr: "0 9 * * *" }
  return { kind: "manual" }
}

export function scheduleTaskTool(input: {
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
}) {
  const runner = RayaTaskRunner.make(input)
  return Tool.define(
    "schedule_task",
    Effect.succeed({
      description:
        "Create a named standing agent with a role, a one-sentence job, and an optional schedule. Use this when the user assigns ongoing work to a specialist. Do not invent cron; pass when in plain English.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type) =>
        runner.tasks
          .create({
            name: params.name,
            role: params.role,
            objective: params.objective,
            capabilities: params.capabilities ? [...params.capabilities] : undefined,
            schedule: params.cron ? { kind: "cron", expr: params.cron } : english(params.when),
            plan: params.plan,
          })
          .pipe(
            Effect.flatMap((agent) =>
              params.runNow
                ? runner.fire(agent.id).pipe(Effect.map((run) => ({ agent, run })))
                : Effect.succeed({ agent, run: undefined as RayaTask.Run | undefined }),
            ),
            Effect.map(({ agent, run }) => ({
              title: "Agent assigned",
              output: run
                ? `Assigned ${agent.name} (${agent.role}) and started a background run.`
                : `Assigned ${agent.name} (${agent.role}). Enable it in Routines or ask to run it now.`,
              metadata: { agentID: agent.id, runID: run?.id },
            })),
            Effect.catch((err) =>
              Effect.succeed({
                title: "Agent not created",
                output: err instanceof Error ? err.message : String(err),
                metadata: {},
              }),
            ),
          ),
    }),
  )
}
