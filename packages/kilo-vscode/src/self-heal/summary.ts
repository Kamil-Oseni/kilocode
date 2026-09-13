import type { KiloClient, KilocodeSelfHealListResponse } from "@kilocode/sdk/v2/client"

type SelfHealItem = KilocodeSelfHealListResponse extends ReadonlyArray<infer Item> ? Item : never

function label(item: SelfHealItem) {
  if (item.artifact?.status === "ready-for-review") return "Fix tested; artifact ready for review"
  if (item.artifact?.status === "preparing") return "Fix tested; preparing review artifact"
  if (item.artifact?.status === "building") return "Fix tested; building review artifact"
  if (item.artifact?.status === "artifact-unavailable") return "Fix tested; review artifact can't be verified"
  if (item.artifact?.status === "interrupted") return "Fix tested; review artifact build was interrupted"
  if (item.artifact?.status === "failed") return "Fix tested; review artifact build failed"
  if (item.completion) return "Fix tested; not released or installed"
  if (item.legacyVerification || item.status === "verified") return "Legacy verification claim; evidence needs review"
  return item.status
}

export function summary(item: SelfHealItem) {
  const session = item.repair?.sessionID ?? item.workSessionID
  const status = label(item)
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
  const source = outcome.completion?.verification
  const verification =
    source?.status === "snapshot-input"
      ? ` Source input ${source.digest} at ${source.head}; ${source.checks.length} check receipt(s). ${source.contract}`
      : ` Delivery source identity is unknown.${source?.status === "unknown" ? ` ${source.reason}` : ""}`
  const artifact = (() => {
    if (!outcome.artifact) return " No review artifact is retained."
    if (outcome.artifact.status === "ready-for-review")
      return ` Review artifact ${outcome.artifact.artifact?.id ?? outcome.artifact.callID} matches its retained receipt. It is ready for review, not ready to install or installed.`
    if (outcome.artifact.status === "preparing")
      return " Review artifact preparation has retained ownership. Inspect it before recovery."
    if (outcome.artifact.status === "building")
      return " Review artifact build has retained ownership. Inspect it before recovery."
    if (outcome.artifact.status === "artifact-unavailable")
      return " The retained review artifact no longer matches its receipt. It can't be installed."
    if (outcome.artifact.status === "interrupted")
      return " Review artifact preparation was interrupted. Its retained ownership prevents automatic replay."
    return " Review artifact preparation failed. Its retained ownership prevents automatic replay."
  })()
  return `Repair attempt ${outcome.id} for ${outcome.itemID}: ${outcome.phase}${outcome.sessionID ? ` in session ${outcome.sessionID}` : ""}${outcome.worktree ? `; checkout ${outcome.worktree.directory} (${outcome.worktree.branch})` : ""}. ${outcome.reason ?? "Inspect the retained attempt before recovery; no automatic replay or takeover is available."}${tested}${verification}${artifact}`
}
