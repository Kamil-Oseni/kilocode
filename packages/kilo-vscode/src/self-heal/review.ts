import type { KiloClient, RayaSelfHealArtifactApproval } from "@kilocode/sdk/v2/client"

export type View = {
  itemID: string
  title: string
  artifactID: string
  source: string
  head: string
  extension: string
  artifact: { digest: string; size: number }
  binary: { digest: string; size: number }
  audit: string
  evidence: string[]
}

type Ready = { status: "ready"; view: View }
type State = Ready | { status: "unavailable"; notice: string }

function bytes(size: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(size / (1024 * 1024))
}

export function detail(view: View) {
  const evidence = view.evidence.length
    ? view.evidence.map((line) => `• ${line}`).join("\n")
    : "• No check summary retained"
  return `Version: ${view.extension}\nSource commit: ${view.head}\nCaptured source SHA-256: ${view.source}\nVSIX: ${bytes(view.artifact.size)} MB\nVSIX SHA-256: ${view.artifact.digest}\nBundled CLI: ${bytes(view.binary.size)} MB\nBundled CLI SHA-256: ${view.binary.digest}\n\nAccepted review\n${view.audit}\n${evidence}\n\nApproval does not install this update.`
}

function same(first: View, next: View) {
  return (
    first.itemID === next.itemID &&
    first.artifactID === next.artifactID &&
    first.source === next.source &&
    first.head === next.head &&
    first.extension === next.extension &&
    first.artifact.digest === next.artifact.digest &&
    first.artifact.size === next.artifact.size &&
    first.binary.digest === next.binary.digest &&
    first.binary.size === next.binary.size
  )
}

async function load(client: KiloClient, id: string, directory: string): Promise<State> {
  const item = await client.kilocode.selfHeal.get({ itemID: id, directory }, { throwOnError: true }).then(
    (result) => result.data,
    () => undefined,
  )
  if (!item) return { status: "unavailable", notice: `Self-heal item ${id} could not be read.` }
  if (item.artifact?.status === "install-ready")
    return {
      status: "unavailable",
      notice: `Artifact ${item.artifact.approval?.artifactID ?? id} is already approved for installation and has not been installed.`,
    }
  const artifact = item.artifact?.artifact
  if (item.artifact?.status !== "ready-for-review" || !artifact)
    return {
      status: "unavailable",
      notice: `Self-heal item ${id} does not have a verified artifact ready for review.`,
    }
  const requirements = item.completion?.goal.audit.requirements ?? []
  const evidence = requirements.flatMap((row) => [
    `${row.passed ? "Passed" : "Failed"}: ${row.requirement}`,
    ...row.evidence.map((entry) => entry.summary),
  ])
  return {
    status: "ready",
    view: {
      itemID: item.id,
      title: item.title,
      artifactID: artifact.id,
      source: artifact.source,
      head: artifact.head,
      extension: artifact.extension,
      artifact: artifact.artifact,
      binary: artifact.binary,
      audit: item.completion?.goal.audit.summary ?? "No accepted review summary retained.",
      evidence,
    },
  }
}

export async function review(input: {
  client: KiloClient
  itemID: string
  directory: string
  confirm: (view: View) => Promise<boolean>
}): Promise<{ notice: string; approval?: RayaSelfHealArtifactApproval }> {
  const first = await load(input.client, input.itemID, input.directory)
  if (first.status !== "ready") return { notice: first.notice }
  if (!(await input.confirm(first.view))) return { notice: "Review closed. No approval was saved." }
  const current = await load(input.client, input.itemID, input.directory)
  if (current.status !== "ready" || !same(first.view, current.view))
    return { notice: "The artifact changed while you reviewed it. Review the current artifact before approving it." }
  const approval = await input.client.kilocode.selfHeal
    .artifactReview(
      {
        itemID: current.view.itemID,
        directory: input.directory,
        artifactID: current.view.artifactID,
        digest: current.view.artifact.digest,
        extension: current.view.extension,
      },
      { throwOnError: true },
    )
    .then(
      (result) => result.data,
      () => undefined,
    )
  if (!approval) return { notice: "Approval could not be saved. Refresh the artifact and review it again." }
  return {
    approval,
    notice: `Artifact ${approval.artifactID} is approved for installation as ${approval.extension}. It has not been installed. Approval receipt ${approval.id}.`,
  }
}
