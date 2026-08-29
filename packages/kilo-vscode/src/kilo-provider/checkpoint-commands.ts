// raya_change - named workspace checkpoints: save a labelled snapshot and jump back to one
import * as vscode from "vscode"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { KiloProvider } from "../KiloProvider"

function ago(ts: number) {
  const secs = Math.round((Date.now() - ts) / 1000)
  if (secs < 60) return "just now"
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

type Item = vscode.QuickPickItem & { id: string }

export function registerCheckpointCommands(
  connection: KiloConnectionService,
  provider: KiloProvider,
): vscode.Disposable {
  const save = vscode.commands.registerCommand("raya.checkpoint.save", async () => {
    const sid = provider.getCurrentSessionId()
    if (!sid) {
      void vscode.window.showWarningMessage("Open a Raya chat before saving a checkpoint.")
      return
    }
    const name = await vscode.window.showInputBox({
      title: "Save Raya checkpoint",
      prompt: "Name this checkpoint of the current workspace",
      placeHolder: "e.g. before refactor",
    })
    if (name === undefined) return
    const dir = provider.directoryForSession(sid)
    const client = await connection.getClientAsync(dir)
    const { data, error } = await client.kilocode.checkpoint.create({ sessionID: sid, directory: dir, name })
    if (error || !data) {
      void vscode.window.showErrorMessage("Could not save a checkpoint here — snapshots are unavailable for this folder.")
      return
    }
    void vscode.window.showInformationMessage(`Checkpoint saved: ${data.name}`)
  })

  const jump = vscode.commands.registerCommand("raya.checkpoint.jump", async () => {
    const sid = provider.getCurrentSessionId()
    if (!sid) {
      void vscode.window.showWarningMessage("Open a Raya chat to jump between checkpoints.")
      return
    }
    const dir = provider.directoryForSession(sid)
    const client = await connection.getClientAsync(dir)
    const { data, error } = await client.kilocode.checkpoint.list({ sessionID: sid, directory: dir })
    if (error || !data || data.length === 0) {
      void vscode.window.showInformationMessage("No checkpoints saved for this chat yet.")
      return
    }
    const items: Item[] = data.map((point) => ({
      label: point.name,
      description: ago(Number(point.createdAt)),
      id: point.id,
    }))
    const pick = await vscode.window.showQuickPick(items, {
      title: "Jump to checkpoint",
      placeHolder: "Restore the workspace to a saved checkpoint",
    })
    if (!pick) return
    const result = await client.kilocode.checkpoint.jump({ sessionID: sid, checkpointID: pick.id, directory: dir })
    if (result.error) {
      void vscode.window.showErrorMessage("Could not restore that checkpoint.")
      return
    }
    void vscode.window.showInformationMessage(`Jumped to checkpoint: ${pick.label}`)
  })

  return vscode.Disposable.from(save, jump)
}
