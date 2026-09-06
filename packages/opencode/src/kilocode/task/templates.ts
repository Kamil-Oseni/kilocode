import { Schema } from "effect"
import { RayaTask } from "."

export const Template = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.String,
  objective: Schema.String,
  capabilities: Schema.Array(Schema.String),
  schedule: RayaTask.Schedule,
})
export type Template = typeof Template.Type

export const templates: Template[] = [
  {
    id: "briefer",
    name: "Briefer",
    role: "briefer",
    objective: "Morning summary of what changed in this repo since the last briefing.",
    capabilities: [] as string[],
    schedule: { kind: "cron" as const, expr: "0 9 * * 1-5" },
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "reviewer",
    objective: "Review the repo for bugs and security issues on a schedule and cite the files you checked.",
    capabilities: [] as string[],
    schedule: { kind: "cron" as const, expr: "0 18 * * 1-5" },
  },
  {
    id: "accountant",
    name: "Accountant",
    role: "accountant",
    objective: "Reconcile receipts, flag anything missing, and draft the monthly summary. Do not send money.",
    capabilities: ["money"],
    schedule: { kind: "manual" as const },
  },
  {
    id: "inbox",
    name: "Inbox",
    role: "inbox",
    objective: "Triage messages and draft replies. Do not send unless the owner opted messages in.",
    capabilities: ["messages"],
    schedule: { kind: "manual" as const },
  },
]
