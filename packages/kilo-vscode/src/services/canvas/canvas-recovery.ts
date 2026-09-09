import * as vscode from "vscode"
import { resolve } from "node:path"
import type { CanvasBuild, CanvasCompiler } from "./canvas-compiler"

/** Keep recovery actions bound to the failed update, even while notifications are open. */
export async function recover(input: {
  compiler: CanvasCompiler
  build: CanvasBuild
  previous: boolean
  current: () => boolean
  render: (build: CanvasBuild) => Promise<CanvasBuild>
}) {
  const keep = input.previous ? "Keep previous version" : "Dismiss"
  const message = input.previous
    ? "Canvas update failed. The saved version remains available."
    : "Canvas could not render. Your draft has been saved."
  while (input.current()) {
    const choice = await vscode.window.showWarningMessage(
      `${message}\n${input.build.error?.slice(0, 1000) ?? ""}`,
      keep,
      "Inspect draft",
      "Retry",
    )
    if (!input.current() || !choice || choice === keep) return
    const path = input.compiler.draftPath(input.build)
    if (choice === "Inspect draft") {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path))
      continue
    }
    if (choice !== "Retry") return
    const normalize = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path))
    if (
      vscode.workspace.textDocuments.some(
        (document) =>
          document.isDirty && document.uri.scheme === "file" && normalize(document.uri.fsPath) === normalize(path),
      )
    ) {
      await vscode.window.showInformationMessage("Save your canvas draft changes before retrying.")
      continue
    }
    const draft = await input.compiler.draft(input.build).catch(async (error: unknown) => {
      if (!input.current()) return
      const detail = error instanceof Error ? error.message.slice(0, 600) : "The draft could not be read."
      await vscode.window.showErrorMessage(
        `Cannot retry this canvas draft. Inspect it, correct its source/data JSON, and save it. ${detail}`,
      )
      return undefined
    })
    if (!input.current()) return
    if (!draft) continue
    const candidate = await input.compiler.create(draft.root, input.build.name, draft.source, draft.data)
    if (!input.current()) return
    await input.render(candidate)
    return
  }
}
