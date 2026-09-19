// raya_change - user-reachable saved Canvas recovery
import * as vscode from "vscode"
import type { CanvasService } from "./canvas-service"

type Target = { root: string; name: string }
type Item = vscode.QuickPickItem & Target

function target(value: unknown): Target | undefined {
  if (!value || typeof value !== "object") return
  if (!("root" in value) || !("name" in value)) return
  if (typeof value.root !== "string" || typeof value.name !== "string") return
  if (!value.root.trim() || !value.name.trim()) return
  return { root: value.root, name: value.name }
}

async function saved(): Promise<Item[]> {
  const folders = vscode.workspace.workspaceFolders ?? []
  const lists = await Promise.all(
    folders.map(async (folder) => {
      const dir = vscode.Uri.joinPath(folder.uri, ".raya", "canvases")
      const entries = await Promise.resolve(vscode.workspace.fs.readDirectory(dir)).catch(
        () => [] as [string, vscode.FileType][],
      )
      return entries
        .filter(([name, kind]) => kind === vscode.FileType.File && name.endsWith(".canvas.tsx"))
        .map(([file]) => ({
          label: file.slice(0, -".canvas.tsx".length),
          description: folders.length > 1 ? folder.name : undefined,
          detail: vscode.Uri.joinPath(dir, file).fsPath,
          root: folder.uri.fsPath,
          name: file.slice(0, -".canvas.tsx".length),
        }))
    }),
  )
  return lists.flat().sort((a, b) => a.label.localeCompare(b.label) || a.root.localeCompare(b.root))
}

export function registerCanvasCommand(service: CanvasService) {
  return vscode.commands.registerCommand("raya.openCanvas", async (value?: unknown) => {
    const direct = target(value)
    const choices = direct ? [] : await saved()
    if (!direct && !choices.length) {
      void vscode.window.showInformationMessage("No saved canvases were found in the open workspace.")
      return
    }
    const selected = direct
      ? direct
      : await vscode.window.showQuickPick(choices, {
          placeHolder: "Choose a saved canvas to reopen",
          matchOnDescription: true,
          matchOnDetail: true,
        })
    if (!selected) return
    return service.open(selected.root, selected.name).catch((error) => {
      const detail = error instanceof Error ? error.message.slice(0, 600) : "The saved record could not be read."
      console.error(`[Kilo New] [Raya] Could not open saved canvas ${selected.name}:`, error)
      void vscode.window.showErrorMessage(`Canvas couldn't reopen. Your saved files are still available. ${detail}`)
      return undefined
    })
  })
}
