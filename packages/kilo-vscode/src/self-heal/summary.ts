import type { KiloClient, KilocodeSelfHealListResponse } from "@kilocode/sdk/v2/client"

type SelfHealItem = KilocodeSelfHealListResponse extends ReadonlyArray<infer Item> ? Item : never

export function summary(item: SelfHealItem) {
  const session = item.repair?.sessionID ?? item.workSessionID
  const status = item.completion
    ? "Fix tested; not released or installed"
    : item.legacyVerification || item.status === "verified"
      ? "Legacy verification claim; evidence needs review"
      : item.status
  return `${item.id} | ${status} | ${item.category}/${item.severity} | ${item.title}${session ? ` | session ${session}` : ""}${item.repair?.worktree ? ` | checkout ${item.repair.worktree.directory} (${item.repair.worktree.branch})` : ""}${item.repair ? ` | repair ${item.repair.phase}${item.repair.reason ? `: ${item.repair.reason}` : ": Reserved; inspect this attempt before recovery. Do not start another repair."}` : ""}`
}

export async function inspect(client: KiloClient, id: string, directory: string) {
  const outcome = await client.kilocode.selfHeal.outcome({ itemID: id, directory }).then(
    (result) => result.data,
    () => undefined,
  )
  if (!outcome)
    return `Repair outcome for ${id} could not be read. Check the item ID and backend connection; do not infer that its ownership was released.`
  const tested = outcome.completion
    ? ` Tested evidence receipt retained for goal revision ${outcome.completion.goal.revision}; not released or installed. This receipt does not confirm the subsequent goal-state save was acknowledged.`
    : " No authoritative tested-completion receipt is retained."
  return `Repair attempt ${outcome.id} for ${outcome.itemID}: ${outcome.phase}${outcome.sessionID ? ` in session ${outcome.sessionID}` : ""}${outcome.worktree ? `; checkout ${outcome.worktree.directory} (${outcome.worktree.branch})` : ""}. ${outcome.reason ?? "Inspect the retained attempt before recovery; no automatic replay or takeover is available."}${tested}`
}
