import { SelfHealInstallation, type Completion } from "./installation"

export type View = {
  itemID: string
  terminal: "verified-active" | "rollback-verified"
  repaired: string
  previous: string
  artifact: string
  rollback: string
}

export function detail(view: View) {
  const outcome =
    view.terminal === "verified-active" ? `Raya ${view.repaired} was verified.` : `Raya ${view.previous} was restored.`
  return `${outcome}\nRepair VSIX SHA-256: ${view.artifact}\nRollback VSIX SHA-256: ${view.rollback}\n\nCleanup removes both retained installable packages and the working journal. A compact completion receipt remains.`
}

export async function cleanup(input: {
  itemID: string
  journal: SelfHealInstallation
  confirm: (view: View) => Promise<boolean>
}): Promise<{ notice: string; receipt?: Completion }> {
  const record = await input.journal.inspect().then(
    (value) => value,
    () => undefined,
  )
  if (!record) {
    const receipt = await input.journal.receipt().then(
      (value) => value,
      () => undefined,
    )
    if (receipt?.itemID === input.itemID)
      return { receipt, notice: `Self-heal installation ${receipt.installationID} is already cleaned up.` }
    return { notice: `No completed self-heal installation for ${input.itemID} is ready for cleanup.` }
  }
  if (record.itemID !== input.itemID)
    return { notice: `No completed self-heal installation for ${input.itemID} is ready for cleanup.` }
  const terminal = record.phase === "cleanup-pending" ? record.terminal : record.phase
  if (terminal !== "verified-active" && terminal !== "rollback-verified")
    return { notice: `Self-heal installation ${record.id} is not in a verified terminal state. Nothing was removed.` }
  const view: View = {
    itemID: record.itemID,
    terminal,
    repaired: record.extension,
    previous: record.previous,
    artifact: record.artifact.digest,
    rollback: record.rollback.artifact.digest,
  }
  if (record.phase !== "cleanup-pending" && !(await input.confirm(view)))
    return { notice: "Cleanup closed. Retained packages and history were kept." }
  const refreshed = await input.journal.inspect().then(
    (value) => value,
    () => undefined,
  )
  if (record.phase !== "cleanup-pending" && JSON.stringify(refreshed) !== JSON.stringify(record))
    return { notice: "The retained installation changed. Review cleanup again." }
  const result = await input.journal.cleanup().then(
    (value) => value,
    () => undefined,
  )
  if (!result) return { notice: "Cleanup could not be confirmed. Retained files were not reported as removed." }
  return {
    receipt: result.receipt,
    notice: result.cleaned
      ? `Self-heal installation ${result.receipt.installationID} is cleaned up. Its completion receipt was kept.`
      : `Self-heal installation ${result.receipt.installationID} was already cleaned up.`,
  }
}
