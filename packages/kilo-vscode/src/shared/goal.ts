// raya_change - Milestone A shared goal command and UI contracts
export type GoalStatus = "active" | "paused" | "complete" | "blocked"

export interface GoalState {
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
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
  progress: Array<{
    at: number
    kind: "status" | "turn" | "continuation"
    message: string
  }>
}

export type GoalCommand = { kind: "usage"; notice: string } | { kind: "start"; objective: string; notice?: string }

const usage = "Usage: /goal <objective>"
const limit = /^(\d+(?:\.\d+)?(?:m|h))(?:\s+([\s\S]+))?$/i

export function parseGoalCommand(text: string): GoalCommand | undefined {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i)
  if (!match) return
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

Perform the first concrete unit of work now in this same turn. Do not stop after planning or restating the objective. Preserve the full objective across turns. Immediately before update_goal(status="complete"), call get_goal to obtain the exact eligible evidence IDs, then check every concrete requirement against those real successful tool calls. If evidence is missing, keep working. A goal must never remain active while waiting for user approval, input, credentials, or another external dependency: use update_goal(status="blocked") with a plain reason instead of repeatedly checking unchanged evidence.
</system-reminder>`
}
