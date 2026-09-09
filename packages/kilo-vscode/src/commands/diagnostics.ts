import * as vscode from "vscode"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { summary } from "../services/diagnostics"

export function registerDiagnostics(context: vscode.ExtensionContext, connection: KiloConnectionService) {
  return vscode.commands.registerCommand("raya.openDiagnostics", async () => {
    const content = summary({
      extension: context.extension.packageJSON.version,
      editor: vscode.version,
      platform: process.platform,
      architecture: process.arch,
      remote: Boolean(vscode.env.remoteName),
      trusted: vscode.workspace.isTrusted,
      folders: vscode.workspace.workspaceFolders?.length ?? 0,
      state: connection.getConnectionState(),
      telemetry: vscode.env.isTelemetryEnabled,
    })
    const document = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(content, null, 2) + "\n",
    })
    await vscode.window.showTextDocument(document, { preview: false })
  })
}
