import type { KiloClient } from "@kilocode/sdk/v2/client"
import { SelfHealInstallation, type Plan, type Record } from "./installation"

export type View = {
  itemID: string
  title: string
  approvalID: string
  artifactID: string
  extension: string
  source: string
  head: string
  artifact: { digest: string; size: number }
  binary: { digest: string; size: number }
}

export function detail(view: View) {
  return `Version: ${view.extension}\nApproval receipt: ${view.approvalID}\nSource commit: ${view.head}\nVSIX SHA-256: ${view.artifact.digest}\nBundled CLI SHA-256: ${view.binary.digest}\n\nVS Code will install these approved bytes. Reload is still required before Raya can verify that this version is active.`
}

async function load(client: KiloClient, id: string, directory: string) {
  const item = await client.kilocode.selfHeal.get({ itemID: id, directory }, { throwOnError: true }).then(
    (result) => result.data,
    () => undefined,
  )
  const artifact = item?.artifact?.artifact
  const approval = item?.artifact?.approval
  if (!item || item.artifact?.status !== "install-ready" || !artifact || !approval) return
  return {
    view: {
      itemID: item.id,
      title: item.title,
      approvalID: approval.id,
      artifactID: artifact.id,
      extension: approval.extension,
      source: approval.source,
      head: approval.head,
      artifact: approval.artifact,
      binary: approval.binary,
    } satisfies View,
    plan: {
      itemID: item.id,
      approvalID: approval.id,
      artifactID: artifact.id,
      source: approval.source,
      head: approval.head,
      extension: approval.extension,
      target: artifact.target,
      output: artifact.output,
      artifact: approval.artifact,
      binary: approval.binary,
    },
  }
}

export async function install(input: {
  client: KiloClient
  itemID: string
  directory: string
  previous: string
  journal: SelfHealInstallation
  confirm: (view: View) => Promise<boolean>
  dispatch: (path: string) => Promise<void>
}): Promise<{ notice: string; record?: Record; reload?: boolean }> {
  const current = await load(input.client, input.itemID, input.directory)
  if (!current) return { notice: `Self-heal item ${input.itemID} does not have an approved artifact ready to install.` }
  if (!(await input.confirm(current.view))) return { notice: "Installation closed. Nothing was installed." }
  const refreshed = await load(input.client, input.itemID, input.directory)
  if (!refreshed || JSON.stringify(refreshed.view) !== JSON.stringify(current.view))
    return { notice: "The approved artifact changed. Review it again before installation." }
  const plan: Plan = { ...refreshed.plan, previous: input.previous }
  const result = await input.journal.run(plan, input.dispatch).then(
    (value) => value,
    () => undefined,
  )
  if (!result) {
    const retained = await input.journal.inspect().then(
      (value) => value,
      () => undefined,
    )
    if (retained?.phase === "failed")
      return { record: retained, notice: `Installation ${retained.id} stopped before dispatch. ${retained.reason}` }
    return {
      record: retained,
      notice: `Installation${retained ? ` ${retained.id}` : ""} could not be confirmed. Its retained record prevents an automatic retry. Reload to inspect the active version.`,
    }
  }
  if (!result.dispatched)
    return {
      record: result.record,
      notice:
        result.record.phase === "active"
          ? `Raya ${result.record.extension} is active and its bundled CLI matches approval ${result.record.approvalID}. Original issue replay is still required.`
          : result.record.phase === "failed"
            ? `Installation ${result.record.id} stopped before dispatch. ${result.record.reason}`
            : `Installation ${result.record.id} is already retained at ${result.record.phase}. No second install was started.`,
    }
  return {
    record: result.record,
    reload: true,
    notice: `Raya ${result.record.extension} was sent to VS Code for installation. Reload to verify the active extension and bundled CLI.`,
  }
}
