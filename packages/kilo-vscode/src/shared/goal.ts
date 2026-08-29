// raya_change - Milestone A shared goal command and UI contracts
export type GoalStatus = "active" | "paused" | "complete" | "blocked"

export interface GoalState {
  objective: string
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
  }
  blockedReason?: string
  audit?: {
    requirements: Array<{
      requirement: string
      passed: boolean
      evidence: Array<{ messageID?: string; callID: string; summary: string }>
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
      requirement: string
      passed: boolean
      evidence: Array<{ messageID?: string; callID: string; summary: string }>
    }>
  }
  progress: Array<{
    at: number
    kind: "status" | "turn" | "continuation"
    message: string
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
      const stripped = objective.replace(inline, "$1").replace(/\s{2,}/g, " ").trim()
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

Perform the first concrete unit of work now in this same turn. Do not stop after planning or restating the objective. Preserve the full objective across turns. For multi-step work, call todowrite immediately, keep exactly one item in progress, and update it as work advances so the user can follow the plan without exposing private chain-of-thought. Immediately before update_goal(status="complete"), call get_goal to obtain the exact eligible evidence IDs, then check every concrete requirement against those real successful tool calls. If evidence is missing, keep working. A goal must never remain active while waiting for user approval, input, credentials, or another external dependency: use update_goal(status="blocked") with a plain reason instead of repeatedly checking unchanged evidence.
</system-reminder>`
}
