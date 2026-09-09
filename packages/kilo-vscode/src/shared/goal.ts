// raya_change - Milestone A shared goal command and UI contracts
import type { inspection } from "@opencode-ai/core/kilocode/evidence-inspection"
export type GoalStatus = "active" | "paused" | "complete" | "blocked"

export interface GoalEvidence {
  record?: { version: 1; digest: string; at: number }
  messageID?: string
  partID?: string
  sessionID?: string
  callID: string
  summary: string
}

export interface GoalSource {
  inspection?: ReturnType<typeof inspection>
  receipt?: "matching" | "unrecorded"
  tool: string
  status: string
  input: string
  output: string
  metadata: string
  truncated: boolean
}

export interface GoalState {
  review?: { status: "pending" | "accepted"; at: number; criteria: string[]; acceptedAt?: number }
  revisions?: Array<{
    id: string
    at: number
    review?: GoalState["review"]
    source: "steering" | "control"
    intent?: string
    objective: string
    criteria?: GoalState["criteria"]
    plan?: GoalState["plan"]
    audit?: GoalState["audit"]
    auditAttempt?: GoalState["auditAttempt"]
  }>
  objective: string
  plan?: {
    review?: boolean
    objective: string
    revision: string
    at: number
    tasks: Array<{
      id: string
      description: string
      output: string
      owner: string
      verification: string
      status: "pending" | "in_progress" | "completed" | "cancelled"
      dependencies: string[]
    }>
  }
  criteria?: Array<{
    id: string
    description: string
    verification: string
    required?: boolean
    review?: boolean
    check?: { kind: "command"; command: string; directory: string }
  }>
  intent?: string
  inputs?: string[]
  dispatch?: {
    id: string
    messageID?: string
    intent: string
    phase: "queued" | "started" | "finished"
    queuedAt: number
    startedAt?: number
    finishedAt?: number
    assistantID?: string
    worker?: string
    outcome?: "completed" | "error" | "interrupted"
  }
  startMessageID?: string
  startSnapshot?: string // raya_change - durable workspace checkpoint for reliable discard
  selfHealID?: string // raya_change - global feedback item repaired by this isolated goal
  status: GoalStatus
  createdAt: number
  updatedAt: number
  activeMs?: number // raya_change - accumulated running time excluding pauses
  activeAt?: number // raya_change - current active interval start
  usage: {
    turns: number
    continuations: number
    toolCalls: number
    retries?: number
  }
  blockedReason?: string
  audit?: {
    requirements: Array<{
      criterionID?: string
      requirement: string
      passed: boolean
      evidence: GoalEvidence[]
    }>
    summary: string
    verifiedAt: number
  }
  // raya_change - last completion attempt (accepted or rejected) for the audit-log view
  auditAttempt?: {
    at: number
    accepted: boolean
    reason?: string
    requirements: Array<{
      criterionID?: string
      requirement: string
      passed: boolean
      evidence: GoalEvidence[]
    }>
  }
  progress: Array<{
    at: number
    kind: "status" | "turn" | "continuation"
    message: string
  }>
  history?: Array<{
    review?: GoalState["review"]
    revisions?: GoalState["revisions"]
    plan?: GoalState["plan"]
    usage?: GoalState["usage"]
    activeMs?: number
    criteria?: GoalState["criteria"]
    audit?: GoalState["audit"]
    auditAttempt?: GoalState["auditAttempt"]
    objective: string
    status: GoalStatus
    createdAt: number
    updatedAt: number
    blockedReason?: string
  }>
}

export type GoalCommand = { kind: "usage"; notice: string } | { kind: "start"; objective: string; notice?: string }

const usage = "Usage: /goal <objective>"
const limit = /^(\d+(?:\.\d+)?(?:m|h))(?:\s+([\s\S]+))?$/i
// raya_change start - infer durable goal intent from ordinary language without arming routine requests
const durable = [
  /\bdone when\b/i,
  /\b(?:do not|don't|never)\s+stop\s+until\b/i,
  /\b(?:keep|continue)\s+(?:working|going)\s+until\b/i,
  /\b(?:make|treat)\s+(?:this|it)\s+(?:as\s+)?a?\s*goal\b/i,
  /\b(?:work|run)\s+(?:on\s+this\s+)?until\b[\s\S]*\b(?:complete|done|passes?|green|verified)\b/i,
  /\b(?:finish|complete|implement)\b[\s\S]{0,240}\b(?:fully|completely)\b[\s\S]{0,240}\b(?:verify|verified|passes?|done)\b/i,
]

export function hasGoalIntent(text: string) {
  const value = text.trim()
  return value.length >= 12 && durable.some((pattern) => pattern.test(value))
}
// raya_change end

// raya_change - a bare /goal token anywhere in the message arms a goal, matching how
// Cursor lets the command sit at the start, middle, or end of a sentence. The token is
// stripped and the remaining prose becomes the objective.
const inline = /(^|\s)\/goal(?=\s|$)/i

export function parseGoalCommand(text: string): GoalCommand | undefined {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i)
  if (!match) {
    const objective = text.trim()
    // raya_change start - accept /goal placed after or inside a sentence, not only leading
    if (inline.test(objective)) {
      const stripped = objective
        .replace(inline, "$1")
        .replace(/\s{2,}/g, " ")
        .trim()
      if (!stripped) return { kind: "usage", notice: usage }
      return {
        kind: "start",
        objective: stripped,
        notice: "Raya recognized the /goal command and will continue until it is verified or honestly blocked.",
      }
    }
    // raya_change end
    if (!hasGoalIntent(objective)) return
    return {
      kind: "start",
      objective,
      notice: "Raya recognized this as durable goal work and will continue until it is verified or honestly blocked.",
    }
  }
  const raw = match[1]?.trim() ?? ""
  if (!raw) return { kind: "usage", notice: usage }
  const timed = raw.match(limit)
  if (!timed) return { kind: "start", objective: raw }
  const objective = timed[2]?.trim()
  const notice = `Time-limited goals are not supported yet. The ${timed[1]} limit was removed.`
  if (!objective) return { kind: "usage", notice: `${notice} ${usage}` }
  return { kind: "start", objective, notice }
}

export function goalPrompt(objective: string) {
  return `<system-reminder>
A persistent goal has just been armed for this session.

Objective:
${objective}

Perform the first concrete unit of work now in this same turn. Do not stop after planning or restating the objective. Preserve the full objective and its constraints across turns. For a goal with dependencies, prefer update_goal_plan when available: read get_goal first, preserve stable task IDs, and use its current intent and plan revision. Reconcile plans marked for review or saved for an earlier objective before relying on them. A saved owner does not authorize delegation, and task status is not completion evidence. When using todowrite and a task list is useful, keep it current and identify the work actually in progress. Independent authorized tasks may be in progress together; keep dependent tasks pending until their prerequisites finish. Do not serialize genuinely parallel work merely to show one active task. Delegate only when authorized and useful, and wait for a task's result before relying on it. Give concise progress updates without exposing private chain-of-thought.

Include every saved criterion in the audit. A criterion explicitly marked required=false may remain unverified with passed=false and an empty evidence list; all claimed successes still require evidence.

Immediately before update_goal(status="complete"), call get_goal to obtain the exact eligible evidence IDs, then check every concrete requirement against those real successful tool calls. If evidence is missing, keep working. When a decision requires user input, request it through an available clarification tool and continue independent authorized work while waiting when possible. Do not block the goal merely because clarification would be helpful. If honest progress is impossible, use update_goal(status="blocked") with a specific reason instead of repeatedly checking unchanged evidence.
</system-reminder>`
}
