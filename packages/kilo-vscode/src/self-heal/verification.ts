import { SelfHealInstallation, type Record } from "./installation"

type Replay = Record["replay"]

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
