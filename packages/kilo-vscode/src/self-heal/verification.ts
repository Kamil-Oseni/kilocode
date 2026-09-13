import { SelfHealInstallation, type Record, type Verification } from "./installation"

type Replay = Record["replay"]
type Goal = {
  status: string
  revision?: string
  review?: { status: string; acceptedAt?: number | string }
  audit?: {
    summary: string
    verifiedAt: number | string
    requirements: Array<{
      requirement: string
      passed: boolean
      evidence: Array<{
        sessionID?: string
        messageID?: string
        partID?: string
        callID: string
        summary: string
        record?: { version: number; digest: string; at: number | string }
      }>
    }>
  }
}

export type View = {
  itemID: string
  sessionID: string
  summary: string
  requirements: Verification["requirements"]
}

export function detail(view: View) {
  const requirements = view.requirements
    .map(
      (item, index) =>
        `${index + 1}. ${item.requirement}\n${item.evidence.map((evidence) => `   Evidence: ${evidence.summary}`).join("\n")}`,
    )
    .join("\n")
  return `Verification session: ${view.sessionID}\n\n${view.summary}\n\n${requirements}\n\nAccept only if this evidence proves the installed repair fixed the original report.`
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function result(record: Record, goal: Goal): Verification | undefined {
  if (
    goal.status !== "complete" ||
    !goal.revision ||
    goal.review?.status !== "accepted" ||
    !finite(goal.review.acceptedAt) ||
    !goal.audit ||
    !finite(goal.audit.verifiedAt) ||
    !goal.audit.summary.trim()
  )
    return
  const requirements = goal.audit.requirements.map((item) => ({
    requirement: item.requirement,
    passed: item.passed,
    evidence: item.evidence.map((evidence) => ({
      sessionID: evidence.sessionID,
      messageID: evidence.messageID,
      partID: evidence.partID,
      callID: evidence.callID,
      summary: evidence.summary,
      record: evidence.record,
    })),
  }))
  if (
    requirements.some(
      (item) =>
        !item.passed ||
        !item.evidence.length ||
        item.evidence.some(
          (evidence) =>
            !evidence.sessionID ||
            !evidence.messageID ||
            !evidence.partID ||
            !evidence.callID.trim() ||
            !evidence.summary.trim() ||
            evidence.record?.version !== 1 ||
            !/^[a-f0-9]{64}$/.test(evidence.record.digest) ||
            !finite(evidence.record.at),
        ),
    ) ||
    JSON.stringify(requirements.map((item) => item.requirement)) !== JSON.stringify(record.replay.report.criteria)
  )
    return
  return {
    sessionID: record.replaySessionID!,
    goalRevision: goal.revision,
    summary: goal.audit.summary,
    verifiedAt: goal.audit.verifiedAt,
    reviewedAt: goal.review.acceptedAt,
    requirements: requirements as Verification["requirements"],
  }
}

export function prompt(input: Replay) {
  const criteria = input.report.criteria.map((value, index) => `${index + 1}. ${value}`).join("\n")
  return `<system-reminder>
Verify the installed Raya repair for self-heal item using the exact retained report below.

Title: ${input.report.title}
Category: ${input.report.category}
Severity: ${input.report.severity}
Original report: ${input.report.description}
Repair approach: ${input.report.approach}

Accepted criteria:
${criteria}

This is verification work. Do not edit Raya source or create another repair. Reproduce the original behavior in the active installed extension. Collect direct runtime or visual evidence for every criterion. State plainly which criteria pass, fail, or remain unverified. Never infer success from the installed version or earlier build checks.

Retained lineage: attempt ${input.attemptID}; repair session ${input.sessionID}; completion ${input.completion}; evidence call ${input.messageID}/${input.callID}.
</system-reminder>`
}

export async function verify(input: {
  itemID: string
  journal: SelfHealInstallation
  create: (replay: Replay) => Promise<string>
  dispatch: (session: string, replay: Replay, text: string) => Promise<void>
}): Promise<{ notice: string; record?: Record }> {
  const retained = await input.journal.inspect().then(
    (value) => value,
    () => undefined,
  )
  if (!retained || retained.itemID !== input.itemID)
    return { notice: `No installed repair for self-heal item ${input.itemID} is retained for verification.` }
  const result = await input.journal
    .replay(async (replay, link) => {
      const session = await input.create(replay)
      await link(session)
      await input.dispatch(session, replay, prompt(replay))
    })
    .then(
      (value) => value,
      () => undefined,
    )
  if (!result) {
    const record = await input.journal.inspect().then(
      (value) => value,
      () => undefined,
    )
    return {
      record,
      notice:
        record?.phase === "replay-unknown"
          ? `Verification dispatch for ${record.itemID} could not be confirmed${record.replaySessionID ? ` in session ${record.replaySessionID}` : ""}. No retry was started.`
          : `The approved Raya repair for ${input.itemID} must be active before verification can start.`,
    }
  }
  if (!result.dispatched)
    return {
      record: result.record,
      notice:
        result.record.phase === "replay-submitted"
          ? `Installed repair verification is already running in session ${result.record.replaySessionID}.`
          : `Verification dispatch for ${result.record.itemID} is retained at ${result.record.phase}${result.record.replaySessionID ? ` in session ${result.record.replaySessionID}` : ""}. No retry was started.`,
    }
  return {
    record: result.record,
    notice: `Installed repair verification started in session ${result.record.replaySessionID}. Review its runtime and visual evidence before accepting the repair.`,
  }
}

export async function accept(input: {
  itemID: string
  journal: SelfHealInstallation
  load: (session: string) => Promise<Goal | undefined>
  confirm: (view: View) => Promise<boolean>
  publish: (record: Record) => Promise<void>
}): Promise<{ notice: string; record?: Record }> {
  const retained = await input.journal.inspect().then(
    (value) => value,
    () => undefined,
  )
  if (!retained || retained.itemID !== input.itemID || !retained.replaySessionID)
    return { notice: `No completed installed-repair verification for ${input.itemID} is ready to review.` }
  if (retained.phase === "verified-active")
    return { record: retained, notice: `Installed repair ${input.itemID} is already accepted as verified.` }
  if (retained.phase.startsWith("verification-"))
    return {
      record: retained,
      notice: `Verification evidence for ${input.itemID} is retained at ${retained.phase}. No publication was repeated.`,
    }
  if (retained.phase !== "replay-submitted")
    return { record: retained, notice: `Installed repair verification is not ready to review.` }
  const first = result(retained, (await input.load(retained.replaySessionID)) ?? { status: "missing" })
  if (!first)
    return {
      record: retained,
      notice: `Verification session ${retained.replaySessionID} does not have a completed, accepted audit with receipt-backed evidence for every retained criterion.`,
    }
  const view = {
    itemID: retained.itemID,
    sessionID: first.sessionID,
    summary: first.summary,
    requirements: first.requirements,
  }
  if (!(await input.confirm(view)))
    return { record: retained, notice: "Verification review closed. Nothing was accepted." }
  const refreshed = result(retained, (await input.load(retained.replaySessionID)) ?? { status: "missing" })
  if (!refreshed || JSON.stringify(refreshed) !== JSON.stringify(first))
    return { record: retained, notice: "The verification evidence changed. Review it again before accepting." }
  const accepted = await input.journal.accept(refreshed, input.publish).then(
    (value) => value,
    () => undefined,
  )
  if (!accepted) {
    const record = await input.journal.inspect().then(
      (value) => value,
      () => undefined,
    )
    return {
      record,
      notice: `Verification evidence publication could not be confirmed. No retry was started.`,
    }
  }
  return {
    record: accepted.record,
    notice: accepted.published
      ? `Installed repair ${accepted.record.itemID} is verified. Its reviewed evidence is retained with the repair.`
      : `Installed repair ${accepted.record.itemID} already has a retained verification decision.`,
  }
}
