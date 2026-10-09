import * as vscode from "vscode"
import path from "node:path"
import type { BrainSettings } from "../settings"
import type { MediaCoordinator } from "./coordinator"

/** Native commands review explicit attachments; model requests cannot supply consent or command arguments. */
export function register(
  context: vscode.ExtensionContext,
  media: MediaCoordinator,
  settings: BrainSettings,
  trusted: (project: string) => void,
) {
  const progress = <T>(title: string, body: (signal: AbortSignal) => Promise<T>) =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (_report, token) => {
        const controller = new AbortController()
        const off = token.onCancellationRequested(() => controller.abort())
        if (token.isCancellationRequested) controller.abort()
        try {
          return await body(controller.signal)
        } finally {
          off.dispose()
        }
      },
    )
  const project = async () => {
    if (!vscode.workspace.isTrusted) throw new Error("Trust the selected media workspace first")
    const folders = vscode.workspace.workspaceFolders
    if (!folders?.length) throw new Error("Open the workspace for this media library")
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick()
    if (!folder) return
    if (folder.uri.scheme !== "file") throw new Error("A local media workspace is required")
    const selected = path.resolve(folder.uri.fsPath)
    trusted(selected)
    return selected
  }
  const setup = async () => {
    const selected = await project()
    if (!selected) return
    const source = await vscode.window.showOpenDialog({
      title: "Choose the folder containing your media attachments",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    })
    trusted(selected)
    if (!source?.[0]) return
    if (source[0].scheme !== "file") throw new Error("Choose a local media source folder")
    const files = await vscode.window.showOpenDialog({
      title: "Select up to 16 media attachments to review",
      defaultUri: source[0],
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: { Media: ["png", "jpg", "jpeg", "wav", "avi", "mp4"] },
    })
    trusted(selected)
    if (!files?.length) return
    if (files.some((file) => file.scheme !== "file")) throw new Error("Choose local media attachments")
    const excluded: string[] = []
    for (;;) {
      const choice = await vscode.window.showQuickPick(["Finish exclusions", "Exclude another folder"], {
        title: "Folders to keep outside this media selection",
        ignoreFocusOut: true,
      })
      trusted(selected)
      if (!choice) return
      if (choice === "Finish exclusions") break
      if (excluded.length >= 128) throw new Error("The exclusion selection is full")
      const folders = await vscode.window.showOpenDialog({
        title: "Choose a folder to exclude",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      })
      trusted(selected)
      if (!folders?.[0]) return
      if (folders[0].scheme !== "file") throw new Error("Choose a local excluded folder")
      excluded.push(folders[0].fsPath)
    }
    const cfg = await settings.load()
    trusted(selected)
    if (!cfg?.managed?.retrieval) throw new Error("Select a managed local Memory runtime before reviewing media")
    const signal = new AbortController().signal
    const managed = cfg.managed
    const draft = await progress("Review selected media attachments", (signal) =>
      media.draft(
        selected,
        { source: source[0].fsPath, files: files.map((file) => file.fsPath), excluded },
        managed,
        signal,
      ),
    )
    trusted(selected)
    const review = draft.review
    const accepted = await vscode.window.showInformationMessage(
      `Approve these ${review.files.length} attachments for ${selected}?\n\n${review.selection.files.map((file) => `${file.title} (${file.kind}, ${file.bytes} bytes)`).join("\n")}\n\nSource: ${review.selection.source}\nExcluded folders: ${excluded.length ? excluded.join(", ") : "None selected"}\n\nImporting and indexing require their own commands. Indexed attachments can be searched locally with Gemma. Media observations do not enable automatic saving of facts.`,
      { modal: true },
      "Approve selection",
    )
    trusted(selected)
    if (accepted !== "Approve selection") return
    await media.approve(draft, signal)
    await vscode.window.showInformationMessage("Media selection approved. Import each attachment before indexing it.")
  }
  const operation = async (op: "inspect" | "import" | "index" | "forget") => {
    const selected = await project()
    if (!selected) return
    const signal = new AbortController().signal
    const grant = await media.grant(selected, signal)
    trusted(selected)
    const item = await vscode.window.showQuickPick(
      grant.review.files.map((file) => ({ label: path.basename(file.path), description: file.kind, file })),
      {
        title: `${op === "inspect" ? "Inspect" : op === "import" ? "Import" : op === "index" ? "Index" : "Forget"} an approved attachment`,
        ignoreFocusOut: true,
      },
    )
    trusted(selected)
    if (!item) return
    if (op !== "inspect") {
      const text =
        op === "import"
          ? `Copy ${item.label} into this private media library? The original stays in its source folder.`
          : op === "index"
            ? `Index ${item.label} locally with Gemma so Raya can search this attachment? Retrieved matches need verification before they can support an answer.`
            : `Remove ${item.label} and its index from this media library? The original stays in its source folder.`
      const label = op === "import" ? "Import attachment" : op === "index" ? "Index attachment" : "Forget attachment"
      const accepted = await vscode.window.showWarningMessage(text, { modal: true }, label)
      trusted(selected)
      if (accepted !== label) return
    }
    const result = await progress(`${op} ${item.label}`, (signal) => media[op](selected, item.file.id, signal))
    trusted(selected)
    await vscode.window.showInformationMessage(
      `${item.label}: ${op === "inspect" ? "inspection completed" : op === "import" ? "import completed" : op === "index" ? "indexing completed" : "removed from the media library"}.`,
    )
    return result
  }
  const commands = {
    mediaSetup: setup,
    mediaInspect: () => operation("inspect"),
    mediaImport: () => operation("import"),
    mediaIndex: () => operation("index"),
    mediaForget: () => operation("forget"),
    mediaCancel: async () => {
      const choices = media.active()
      if (!choices.length) throw new Error("No original media operation is active")
      const active =
        choices.length === 1
          ? choices[0]
          : (
              await vscode.window.showQuickPick(
                choices.map((value) => ({ label: value.op, description: value.project, value })),
                { title: "Stop an original media operation", ignoreFocusOut: true },
              )
            )?.value
      if (!active) return
      trusted(active.project)
      await media.cancel(active)
    },
  }
  for (const [name, action] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`kilo-code.new.memory.${name}`, (...args: unknown[]) => {
        if (args.length) throw new Error("Native media commands accept no supplied arguments")
        return action()
      }),
    )
  }
}
