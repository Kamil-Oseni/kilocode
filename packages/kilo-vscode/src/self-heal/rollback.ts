import { SelfHealInstallation, type Record } from "./installation"

export type View = {
  itemID: string
  installationID: string
  repaired: string
  previous: string
  artifact: { digest: string; size: number }
  binary: { digest: string; size: number }
}

export function detail(view: View) {
  return `Current repair: ${view.repaired}\nRestore version: ${view.previous}\nRollback VSIX SHA-256: ${view.artifact.digest}\nRollback CLI SHA-256: ${view.binary.digest}\n\nVS Code will install the retained earlier package. Reload is required before Raya can verify the restored version and CLI.`
}

export async function rollback(input: {
  itemID: string
  journal: SelfHealInstallation
  confirm: (view: View) => Promise<boolean>
  dispatch: (path: string) => Promise<void>
}): Promise<{ notice: string; record?: Record; reload?: boolean }> {
  const retained = await input.journal.inspect().then(
    (value) => value,
    () => undefined,
  )
  if (!retained || retained.itemID !== input.itemID)
    return { notice: `No retained installation for self-heal item ${input.itemID} is available to roll back.` }
  if (retained.phase === "rollback-verified")
    return { record: retained, notice: `Raya ${retained.previous} is already restored and verified.` }
  if (retained.phase.startsWith("rollback-"))
    return {
      record: retained,
      notice: `Rollback ${retained.id} is retained at ${retained.phase}. No second installation was started.`,
    }
  const view: View = {
    itemID: retained.itemID,
    installationID: retained.id,
    repaired: retained.extension,
    previous: retained.previous,
    artifact: retained.rollback.artifact,
    binary: retained.rollback.binary,
  }
  if (!(await input.confirm(view))) return { record: retained, notice: "Rollback closed. Nothing was installed." }
  const refreshed = await input.journal.inspect().then(
    (value) => value,
    () => undefined,
  )
  if (!refreshed || JSON.stringify(refreshed) !== JSON.stringify(retained))
    return { record: refreshed, notice: "The retained installation changed. Review rollback again." }
  const result = await input.journal.rollback(input.dispatch).then(
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
        record?.phase === "rollback-failed"
          ? `Rollback ${record.id} stopped before installation. ${record.reason}`
          : `Rollback${record ? ` ${record.id}` : ""} could not be confirmed. No retry was started. Reload to inspect the active version.`,
    }
  }
  if (!result.dispatched)
    return {
      record: result.record,
      notice: `Rollback ${result.record.id} is already retained at ${result.record.phase}. No second installation was started.`,
    }
  return {
    record: result.record,
    reload: true,
    notice: `Raya ${result.record.previous} was sent to VS Code for restoration. Reload to verify the restored extension and bundled CLI.`,
  }
}
