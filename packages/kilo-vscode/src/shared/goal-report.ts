import type { GoalEvidence, GoalState } from "./goal"

type Goal = Pick<
  GoalState,
  "objective" | "status" | "createdAt" | "updatedAt" | "criteria" | "audit" | "auditAttempt" | "blockedReason"
> &
  Partial<Pick<GoalState, "usage" | "activeMs" | "plan" | "revisions" | "review">>

function activity(goal: Goal) {
  const lines = ["", "## Recorded activity", ""]
  if (goal.usage) {
    lines.push(
      `Turns: ${goal.usage.turns}`,
      `Tool calls: ${goal.usage.toolCalls}`,
      `Continuations: ${goal.usage.continuations}`,
    )
  }
  if (!goal.usage) lines.push("Execution counters were not retained.")
  if (goal.activeMs !== undefined && Number.isFinite(goal.activeMs) && goal.activeMs >= 0)
    lines.push(
      `Accumulated active time: ${(goal.activeMs / 1000).toFixed(1)} seconds (saved value; excludes any unsaved active interval).`,
    )
  return lines
}

const quote = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")
const date = (value: number) => {
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? "Unavailable" : time.toISOString()
}

function source(evidence: GoalEvidence) {
  const lines: string[] = []

  lines.push(
    "",
    "Evidence:",
    quote(evidence.summary),
    quote(
      [
        `Session: ${evidence.sessionID ?? "not recorded"}`,
        `Message: ${evidence.messageID ?? "not recorded"}`,
        `Part: ${evidence.partID ?? "not recorded"}`,
        `Call: ${evidence.callID}`,
      ].join("\n"),
    ),
  )
  if (evidence.record)
    lines.push(
      quote(
        `Recorded result digest (v${evidence.record.version}): ${evidence.record.digest}\nObserved: ${date(evidence.record.at)}`,
      ),
    )

  return lines
}

function planning(goal: Pick<Goal, "objective" | "plan">) {
  const lines: string[] = []
  if (goal.plan) {
    lines.push("", "## Saved work plan", "", "Recorded task declarations; not completion evidence.")
    if (goal.plan.review || goal.plan.objective !== goal.objective)
      lines.push("Plan needs review: goal requirements changed.")
    lines.push(quote(`Plan objective: ${goal.plan.objective}`))
    for (const task of goal.plan.tasks)
      lines.push(
        "",
        quote(
          `${task.id}: ${task.description} (${task.status})\nExpected output: ${task.output}\nPlanned owner: ${task.owner}\nDependencies: ${task.dependencies.join(", ") || "None"}\nVerification: ${task.verification}`,
        ),
      )
  }
  return lines
}

function review(value: Goal["review"]) {
  if (!value) return ["", "User review: no separate acceptance was recorded."]
  const lines: string[] = []
  lines.push(
    "",
    "## Goal-control review",
    "",
    `Review: ${value.status}`,
    `Requested: ${date(value.at)}`,
    ...(value.acceptedAt === undefined ? [] : [`Accepted: ${date(value.acceptedAt)}`]),
    quote(`Criteria: ${value.criteria.join(", ")}`),
    "Person identity was not recorded; this does not verify later artifact changes.",
  )
  return lines
}

function contract(goal: Pick<Goal, "criteria" | "audit" | "auditAttempt" | "review">) {
  const lines: string[] = []
  lines.push("", "## Saved acceptance criteria", "")
  if (!goal.criteria?.length) lines.push("No structured acceptance criteria were retained.")
  for (const item of goal.criteria ?? [])
    lines.push(
      `### Criterion ${item.id}`,
      "",
      item.required === false ? "Optional" : "Required",
      ...(item.review ? ["Requires your review before completion."] : []),
      "",
      quote(item.description),
      "",
      "Verification:",
      quote(item.verification),
      ...(item.check
        ? ["", "Required command:", quote(item.check.command), "Working directory:", quote(item.check.directory)]
        : []),
      "",
    )
  lines.push(...review(goal.review))
  const audit =
    goal.auditAttempt ??
    (goal.audit ? { accepted: true, requirements: goal.audit.requirements, reason: undefined } : undefined)
  lines.push("", "## Completion audit", "")
  if (!audit) lines.push("No completion audit was retained.")
  if (audit) {
    lines.push(
      audit.accepted
        ? "Evidence references accepted at submission."
        : "Completion rejected; submitted claims are unverified.",
    )
    if (audit.accepted && goal.audit)
      lines.push("", quote(goal.audit.summary), `Verified: ${date(goal.audit.verifiedAt)}`)
    if (audit.reason) lines.push("", "Rejection reason:", quote(audit.reason))
    for (const item of audit.requirements) {
      lines.push("", "### Audited requirement", "", quote(item.requirement))
      if (item.criterionID) lines.push(`Criterion: ${item.criterionID}`)
      lines.push(`Reported satisfied: ${item.passed ? "yes" : "no"}`)
      for (const evidence of item.evidence) lines.push(...source(evidence))
    }
  }
  return lines
}

function revisions(goal: Goal) {
  const lines = [
    "",
    "## Earlier requirement versions",
    "",
    "Superseded requirements do not satisfy the current goal. Person identity was not recorded.",
  ]
  if (!goal.revisions?.length) lines.push("No earlier requirement versions were retained.")
  for (const [index, item] of (goal.revisions ?? []).entries()) {
    lines.push(
      "",
      `### Version ${index + 1}`,
      "",
      `Replaced: ${date(item.at)}`,
      `Entry point: ${item.source}`,
      quote(`Version ID: ${item.id}`),
      "",
      quote(item.objective),
    )
    lines.push(quote([...planning(item), ...contract(item)].join("\n")))
  }
  return lines
}

export function report(goal: Goal, sessionID?: string) {
  const lines = [
    "# Raya goal report",
    "",
    `Status: ${goal.status}`,
    `Created: ${date(goal.createdAt)}`,
    `Updated: ${date(goal.updatedAt)}`,
    "",
    "## Objective",
    "",
    quote(goal.objective),
  ]
  if (sessionID) lines.push("", "Session:", quote(sessionID))
  if (goal.blockedReason) lines.push("", "## Blocker", "", quote(goal.blockedReason))
  lines.push(...planning(goal))
  lines.push(...activity(goal))
  lines.push(...contract(goal), ...revisions(goal))
  lines.push(
    "",
    "## Review limits and next action",
    "",
    "This report copies saved goal records. It does not rerun checks, verify current files, include the original tool output, or independently identify a reviewer. Goal-control acceptance is included only when saved. Cost and deliverable inventories are not included in this report.",
    "",
    "Review each criterion and open its cited source in Raya before relying on the result. Missing source records or criteria require further verification.",
    "Accepted references do not establish complete business-outcome coverage or user acceptance. A saved command binding checks the cited command and working directory; prose-only verification has no such binding.",
    "",
  )
  return lines.join("\n")
}
