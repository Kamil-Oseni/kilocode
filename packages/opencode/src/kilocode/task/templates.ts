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
    name: "Morning project brief",
    role: "briefer",
    objective:
      "Summarize project changes since the previous briefing, or the last working day if no briefing exists. Report in this run's conversation: important changes, unresolved risks, and suggested next actions. Cite the files or commits supporting each finding, state the period reviewed, and identify anything you could not inspect. Do not modify files or send messages.",
    capabilities: [],
    schedule: { kind: "cron", expr: "0 9 * * 1-5" },
  },
  {
    id: "reviewer",
    name: "Repository maintenance check",
    role: "reviewer",
    objective:
      "Review the repository for actionable maintenance issues. Report in this run's conversation: prioritized findings, affected file paths, supporting evidence, and recommended fixes. Distinguish observed failures from suspected risks and list checks you could not run. Do not claim checks passed without their recorded results. Propose changes without editing files, installing dependencies, or publishing anything.",
    capabilities: [],
    schedule: { kind: "cron", expr: "0 18 * * 1-5" },
  },
  {
    id: "document-review",
    name: "Weekly document review",
    role: "reviewer",
    objective:
      "Review documents in the selected folder for outdated statements, contradictions, missing decisions, and unclear ownership. Report in this run's conversation: prioritized findings with document paths and section references, proposed corrections, and unresolved questions. State which documents were reviewed and which could not be read. Suggest edits without modifying source documents or contacting their owners.",
    capabilities: [],
    schedule: { kind: "cron", expr: "0 16 * * 5" },
  },
  {
    id: "folder-report",
    name: "Watched-folder report",
    role: "briefer",
    objective:
      "Report changes in the selected folder since the previous report. On the first run, describe the current contents as a baseline rather than inventing changes. Include changed file paths, a concise description of each change, the comparison period, and unreadable or missing files in this run's conversation. Do not modify files. This starter runs on demand; configure a supported trigger separately to automate it.",
    capabilities: [],
    schedule: { kind: "manual" },
  },
  {
    id: "research-digest",
    name: "Research digest",
    role: "generalist",
    objective:
      "Research the topic and sources specified in this standing job. If the topic is missing, ask for it before researching. Deliver a digest in this run's conversation with key findings, source links, publication dates where available, disagreements, and open questions. Distinguish new information from earlier reports and unsupported claims from verified evidence. State unavailable sources. Do not subscribe, purchase access, or send the digest externally.",
    capabilities: [],
    schedule: { kind: "cron", expr: "0 10 * * 1" },
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
