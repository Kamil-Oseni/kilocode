import type { GoalEvidence, GoalState } from "./goal"

type Goal = Pick<
  GoalState,
  "objective" | "status" | "createdAt" | "updatedAt" | "criteria" | "audit" | "auditAttempt" | "blockedReason"
> &
  Partial<
    Pick<GoalState, "usage" | "charges" | "activeMs" | "plan" | "revisions" | "review" | "budget" | "budgetHit">
  > &
  Partial<Pick<GoalState, "deliverables">>

function limitName(hit: NonNullable<GoalState["budgetHit"]>) {
  if (hit.kind === "active-time") return "active time"
  if (hit.kind === "model-cost") return "recorded model cost"
  if (hit.kind === "recovery-attempts") return "automatic recovery attempts"
  return `${hit.currency} non-model charge cost${hit.uncertain ? " with an unknown amount" : ""}`
}

function limits(goal: Pick<Goal, "budget" | "budgetHit">) {
  const lines = ["", "## Saved limits", ""]
  if (!goal.budget)
    lines.push(
      "No active-time, recorded model-cost, non-model charge, recovery-attempt, or concurrent-child limit was saved.",
    )
  if (goal.budget?.activeMs !== undefined)
    lines.push(`Active-time limit: ${(goal.budget.activeMs / 1000).toFixed(1)} seconds.`)
  if (goal.budget?.modelCost !== undefined)
    lines.push(`Goal-session recorded model-cost limit: $${goal.budget.modelCost.toFixed(6)}.`)
  if (goal.budget?.recoveryAttempts !== undefined)
    lines.push(`Consecutive automatic recovery-attempt limit: ${goal.budget.recoveryAttempts}.`)
  if (goal.budget?.concurrentChildren !== undefined)
    lines.push(`Concurrent delegated-child limit: ${goal.budget.concurrentChildren}.`)
  for (const item of goal.budget?.chargeCosts ?? [])
    lines.push(
      `${item.currency} non-model charge limit: ${item.limit.toFixed(6)}; reserve ${item.reservation.toFixed(6)} before each supported billed operation.`,
    )
  if (goal.budget?.chargeCosts?.length)
    lines.push(
      "Reservations govern Raya's process-owned admission and are released after settlement. A provider may report a larger final bill; unknown amounts pause the matching currency limit.",
    )
  if (goal.budgetHit)
    lines.push(
      `Limit reached: ${limitName(goal.budgetHit)}; limit ${goal.budgetHit.limit}; observed ${goal.budgetHit.observed}; recorded ${date(goal.budgetHit.at)}.`,
    )
  lines.push(
    "Enforcement pauses before another continuation after an observed time, cost or recovery limit. It does not recall a turn already running. Recovery attempts are consecutive and renew after successful work or a revised approach. A child slot is reserved before child-session creation and released when that live task finishes or is cancelled. Reducing the limit does not cancel running children. Raya may stop earlier when repeated work is unsafe. The model-cost limit has the recorded coverage stated below.",
  )
  return lines
}

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
  lines.push(...models(goal))
  return lines
}

function models(goal: Pick<Goal, "usage">) {
  const lines = ["", "## Recorded model usage", ""]
  if (goal.usage?.cost !== undefined && Number.isFinite(goal.usage.cost))
    lines.push(`Recorded goal-tree model cost: $${goal.usage.cost.toFixed(6)}`)
  if (goal.usage?.cost === undefined) lines.push("Goal-session model cost was not retained.")
  if (goal.usage?.cost !== undefined && goal.usage.descendantCost !== undefined) {
    const direct = Math.max(0, goal.usage.cost - goal.usage.descendantCost)
    lines.push(
      `Direct goal-session model cost: $${direct.toFixed(6)}.`,
      `Delegated-session model cost: $${goal.usage.descendantCost.toFixed(6)} (first-hop child totals include deeper descendants recursively).`,
    )
  }
  if (goal.usage && goal.usage.descendantCost === undefined)
    lines.push("Delegated-session cost attribution was not retained for this goal version.")
  if (goal.usage?.tokens) {
    const tokens = goal.usage.tokens
    lines.push(
      `Tokens: input ${tokens.input}; output ${tokens.output}; reasoning ${tokens.reasoning}; cache read ${tokens.cache.read}; cache write ${tokens.cache.write}.`,
    )
  }
  if (!goal.usage?.tokens) lines.push("Goal-session token totals were not retained.")
  if (goal.usage?.descendantTokens) {
    const tokens = goal.usage.descendantTokens
    lines.push(
      `Delegated-session tokens included above: input ${tokens.input}; output ${tokens.output}; reasoning ${tokens.reasoning}; cache read ${tokens.cache.read}; cache write ${tokens.cache.write}.`,
    )
  }
  if (goal.usage && !goal.usage.descendantTokens)
    lines.push("Delegated-session token attribution was not retained for this goal version.")
  lines.push(
    "Coverage: settled assistant messages in the goal and its admitted task-session tree. Parent message cost already contains descendant cost recursively, so delegated cost is attributed without adding it twice. Tool fees, GPT-Live usage and external service charges are not included unless separately recorded.",
  )
  return lines
}

function charges(goal: Pick<Goal, "charges">) {
  const lines = ["", "## Recorded non-model charges", ""]
  if (goal.charges === undefined) {
    lines.push("No non-model charge ledger was retained for this goal version.")
    return lines
  }
  if (!goal.charges.length) lines.push("No non-model charges were recorded.")
  const sums = new Map<string, number>()
  for (const item of goal.charges) {
    if (item.coverage === "recorded") sums.set(item.currency, (sums.get(item.currency) ?? 0) + item.amount)
  }
  for (const [currency, amount] of sums) lines.push(`Recorded ${currency}: ${amount.toFixed(6)}.`)
  for (const item of goal.charges) {
    const source = item.service ?? item.provider ?? item.kind
    const quantity = item.quantity === undefined ? "" : ` Quantity: ${item.quantity} ${item.unit ?? "units"}.`
    const origin = item.source ? ` Billing source: ${item.source}.` : ""
    lines.push(
      item.coverage === "recorded"
        ? `${source}: ${item.currency} ${item.amount.toFixed(6)}.${quantity}${origin}`
        : `${source}: ${item.currency ? `${item.currency} monetary cost unknown` : "monetary cost unknown"}.${quantity} ${item.reason}${origin}`,
    )
  }
  lines.push(
    "Coverage: only explicit retained receipts. Currencies remain separate. Unknown amounts and non-model charges are not added to the recorded model-cost limit.",
  )
  return lines
}

function deliverables(goal: Pick<Goal, "deliverables">) {
  const lines = ["", "## Deliverables", ""]
  if (goal.deliverables === undefined) {
    lines.push("No deliverable inventory was retained for this goal version.")
    return lines
  }
  if (goal.deliverables.length === 0) lines.push("No deliverables were present in the cited completion evidence.")
  for (const item of goal.deliverables) {
    if (item.kind === "canvas") {
      lines.push(
        "",
        "### Canvas",
        "",
        quote(item.path),
        `Recorded version: ${item.version}`,
        `Source tool: ${item.tool}`,
        quote(
          `Session: ${item.evidence.sessionID ?? "not recorded"}\nMessage: ${item.evidence.messageID ?? "not recorded"}\nPart: ${item.evidence.partID ?? "not recorded"}\nCall: ${item.evidence.callID}`,
        ),
        "Evidence summary:",
        quote(item.evidence.summary),
      )
      continue
    }
    if (item.kind === "browser-download") {
      lines.push(
        "",
        "### Browser download",
        "",
        quote(item.filename),
        `Artifact path: ${item.path}`,
        `Source URL: ${item.url}`,
        `Transfer: ${item.transferID}`,
        `Bytes: ${item.bytes}`,
        `SHA-256: ${item.sha256}`,
        `Source tool: ${item.tool}`,
        quote(
          `Session: ${item.evidence.sessionID ?? "not recorded"}\nMessage: ${item.evidence.messageID ?? "not recorded"}\nPart: ${item.evidence.partID ?? "not recorded"}\nCall: ${item.evidence.callID}`,
        ),
        "Evidence summary:",
        quote(item.evidence.summary),
      )
      continue
    }
    lines.push(
      "",
      `### ${item.revision.status === "absent" ? "Removed file" : "File"}`,
      "",
      quote(item.path),
      item.revision.status === "captured"
        ? `Captured SHA-256: ${item.revision.sha256}`
        : `Verified absent beneath: ${item.revision.parent}`,
      `Source tool: ${item.tool}`,
      quote(
        `Session: ${item.evidence.sessionID ?? "not recorded"}\nMessage: ${item.evidence.messageID ?? "not recorded"}\nPart: ${item.evidence.partID ?? "not recorded"}\nCall: ${item.evidence.callID}`,
      ),
      "Evidence summary:",
      quote(item.evidence.summary),
    )
  }
  lines.push(
    "",
    "Coverage: revision-safe file outputs and mutations, ready Canvas versions and host-verified completed browser downloads cited by the accepted completion audit. Links, other external records and uncited outputs are not included.",
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
    lines.push(
      quote(
        [
          ...planning(item),
          ...limits(item),
          ...models(item),
          ...charges(item),
          ...deliverables(item),
          ...contract(item),
        ].join("\n"),
      ),
    )
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
  lines.push(...limits(goal))
  lines.push(...activity(goal))
  lines.push(...charges(goal))
  lines.push(...deliverables(goal))
  lines.push(...contract(goal), ...revisions(goal))
  lines.push(
    "",
    "## Review limits and next action",
    "",
    "This report copies saved goal records. It does not rerun checks, verify current files, include the original tool output, independently identify a reviewer, or inventory external and uncited deliverables. Goal-control acceptance is included only when saved. Recorded model usage has the coverage stated above and is not a complete project cost.",
    "",
    "Review each criterion and open its cited source in Raya before relying on the result. Missing source records or criteria require further verification.",
    "Accepted references do not establish complete business-outcome coverage or user acceptance. A saved command binding checks the cited command and working directory; prose-only verification has no such binding.",
    "",
  )
  return lines.join("\n")
}
