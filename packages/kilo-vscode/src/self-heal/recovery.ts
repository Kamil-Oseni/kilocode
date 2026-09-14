import { join } from "node:path"
import * as vscode from "vscode"
import { SelfHealInstallation } from "./installation"

export async function recover(context: vscode.ExtensionContext) {
  const root = join(context.globalStorageUri.fsPath, "self-heal-install")
  const journal = new SelfHealInstallation(root)
  const retained = await journal.inspect()
  if (retained?.phase === "cleanup-pending") {
    const result = await journal.cleanup()
    await vscode.window.showInformationMessage(
      `Raya finished cleanup for self-heal installation ${result.receipt.installationID}. Its completion receipt was kept.`,
    )
    return
  }
  const binary = join(context.extensionUri.fsPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
  const version = String(context.extension.packageJSON.version)
  const result = await journal.activate(version, binary)
  if (!result) return
  const record = result.record
  if (record.phase === "rollback-verified" && result.changed) {
    await vscode.window.showInformationMessage(
      `Raya ${record.previous} is restored and its bundled CLI matches the retained rollback package.`,
    )
    return
  }
  if (record.phase === "rollback-failed") {
    await vscode.window.showErrorMessage(`Raya could not verify rollback ${record.id}. ${record.reason}`)
    return
  }
  if (record.phase.startsWith("rollback-")) {
    const choice = await vscode.window.showWarningMessage(
      `Rollback ${record.id} is waiting for reload verification. No retry was started.`,
      "Reload",
      "Later",
    )
    if (choice === "Reload") await vscode.commands.executeCommand("workbench.action.reloadWindow")
    return
  }
  if (record.phase === "active" && result.changed) {
    await vscode.window.showInformationMessage(
      `Raya ${record.extension} is active and its bundled CLI matches approval ${record.approvalID}. The original issue still needs verification.`,
    )
    return
  }
  if (record.phase === "failed") {
    await vscode.window.showErrorMessage(`Raya could not verify installation ${record.id}. ${record.reason}`)
    return
  }
  if (record.extension === version) return
  const uncertain = record.phase === "installing"
  const choice = await vscode.window.showWarningMessage(
    uncertain
      ? `Installation ${record.id} may have been interrupted. Reload to check whether Raya ${record.extension} became active. No retry was started.`
      : `Raya ${record.extension} is installed and waiting for reload verification.`,
    "Reload",
    "Later",
  )
  if (choice === "Reload") await vscode.commands.executeCommand("workbench.action.reloadWindow")
}
