import type { KiloClient } from "@kilocode/sdk/v2/client"

export function summary(item: {
  id: string
  status: string
  category: string
  severity: string
  title: string
  workSessionID?: string
  repair?: { phase: string; sessionID?: string; reason?: string; worktree?: { directory: string; branch: string } }
}) {
  const session = item.repair?.sessionID ?? item.workSessionID
  return `${item.id} | ${item.status} | ${item.category}/${item.severity} | ${item.title}${session ? ` | session ${session}` : ""}${item.repair?.worktree ? ` | checkout ${item.repair.worktree.directory} (${item.repair.worktree.branch})` : ""}${item.repair ? ` | repair ${item.repair.phase}${item.repair.reason ? `: ${item.repair.reason}` : ": Reserved; inspect this attempt before recovery. Do not start another repair."}` : ""}`
}

export async function inspect(client: KiloClient, id: string, directory: string) {
  const outcome = await client.kilocode.selfHeal.outcome({ itemID: id, directory }).then(
    (result) => result.data,
    () => undefined,
  )
  if (!outcome)
    return `Repair outcome for ${id} could not be read. Check the item ID and backend connection; do not infer that its ownership was released.`
  return `Repair attempt ${outcome.id} for ${outcome.itemID}: ${outcome.phase}${outcome.sessionID ? ` in session ${outcome.sessionID}` : ""}${outcome.worktree ? `; checkout ${outcome.worktree.directory} (${outcome.worktree.branch})` : ""}. ${outcome.reason ?? "Inspect the retained attempt before recovery; no automatic replay or takeover is available."}`
}
