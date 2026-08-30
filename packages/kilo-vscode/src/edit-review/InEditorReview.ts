// raya_change - new file
//
// In-editor agent-edit review. When the active session has uncommitted agent
// edits, this paints a green whole-line highlight on the changed lines *inside
// the edited file* and offers inline "Keep" / "Undo" CodeLens at the top of the
// change — so review no longer only lives in the separate "review changes"
// screen. Undo reuses the same per-file server op the webview uses
// (session.discardChanges with a single `files` entry); Keep just dismisses the
// in-editor chrome for that file for the rest of the session.

import * as vscode from "vscode"
import * as path from "node:path"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { addedRanges, type LineRange } from "./patch-ranges"

export interface InEditorReviewDeps {
  readonly connection: KiloConnectionService
  /** Currently active session id, or undefined. */
  readonly session: () => string | undefined
  /** Workspace directory the session's diff paths are relative to. */
  readonly directory: (sessionID?: string) => string
}

interface FileReview {
  /** Path exactly as session.diff returned it — what discardChanges expects. */
  readonly file: string
  /** Resolved, normalized absolute path used to match open editors. */
  readonly abs: string
  readonly ranges: LineRange[]
}

export interface InEditorReview extends vscode.Disposable {
  /** Re-derive highlights from the backend session diff. */
  refresh(): void
}

export function registerInEditorReview(context: vscode.ExtensionContext, deps: InEditorReviewDeps): InEditorReview {
  const decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })

  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p)
  const changes = new vscode.EventEmitter<void>()

  let reviews = new Map<string, FileReview>()
  let sid: string | undefined
  // Files the user Kept (or just Undid) this session — stop painting them even
  // before the next backend refresh confirms the change is gone.
  const dismissed = new Set<string>()

  const apply = (editor: vscode.TextEditor) => {
    const key = norm(editor.document.uri.fsPath)
    const review = reviews.get(key)
    if (!review || dismissed.has(key)) {
      editor.setDecorations(decoration, [])
      return
    }
    const last = editor.document.lineCount - 1
    const ranges = review.ranges
      .filter((r) => r.start <= last)
      .map((r) => new vscode.Range(r.start, 0, Math.min(r.end, last), 0))
    editor.setDecorations(decoration, ranges)
  }

  const applyAll = () => {
    for (const editor of vscode.window.visibleTextEditors) apply(editor)
  }

  async function reload() {
    const next = deps.session()
    if (next !== sid) {
      sid = next
      dismissed.clear()
    }
    const built = new Map<string, FileReview>()
    if (sid && deps.connection.getConnectionState() === "connected") {
      const dir = deps.directory(sid)
      const res = await deps.connection
        .getClient()
        .session.diff({ sessionID: sid, directory: dir })
        .catch((err) => {
          console.error("[Raya] in-editor review diff failed:", err)
          return undefined
        })
      for (const item of res?.data ?? []) {
        if (!item.file || typeof item.patch !== "string") continue
        const ranges = addedRanges(item.patch)
        if (!ranges.length) continue
        const abs = norm(path.resolve(dir, item.file))
        built.set(abs, { file: item.file, abs, ranges })
      }
    }
    reviews = built
    applyAll()
    changes.fire()
  }

  const refresh = () => void reload()

  const targetKey = (arg?: string) => arg ?? norm(vscode.window.activeTextEditor?.document.uri.fsPath ?? "")

  const undo = async (arg?: string) => {
    const key = targetKey(arg)
    const review = reviews.get(key)
    if (!review || !sid || deps.connection.getConnectionState() !== "connected") return
    const target = sid
    await deps.connection
      .getClient()
      .session.discardChanges({ sessionID: target, directory: deps.directory(target), files: [review.file] })
      .catch((err) => {
        console.error("[Raya] in-editor undo failed:", err)
        void vscode.window.showErrorMessage("Raya: couldn't undo this file's changes.")
      })
    dismissed.add(key)
    applyAll()
    changes.fire()
    refresh()
  }

  const keep = (arg?: string) => {
    dismissed.add(targetKey(arg))
    applyAll()
    changes.fire()
  }

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changes.event,
    provideCodeLenses(document) {
      const key = norm(document.uri.fsPath)
      const review = reviews.get(key)
      if (!review || dismissed.has(key) || !review.ranges.length) return []
      const total = review.ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0)
      // One Keep/Undo cluster per contiguous changed region, so the affordance
      // sits next to each hunk. The backend only reverts whole files, so the
      // labels say "file" to stay honest even though they're rendered per hunk.
      const out: vscode.CodeLens[] = []
      review.ranges.forEach((range, i) => {
        const at = new vscode.Range(range.start, 0, range.start, 0)
        const hunk = range.end - range.start + 1
        const label =
          i === 0
            ? `$(sparkle) ${total} agent ${total === 1 ? "line" : "lines"}`
            : `$(sparkle) +${hunk}`
        out.push(
          new vscode.CodeLens(at, { title: label, command: "" }),
          new vscode.CodeLens(at, { title: "$(check) Keep file", command: "raya.editReview.keepFile", arguments: [key] }),
          new vscode.CodeLens(at, { title: "$(discard) Undo file", command: "raya.editReview.undoFile", arguments: [key] }),
        )
      })
      return out
    },
  }

  context.subscriptions.push(
    decoration,
    changes,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lenses),
    vscode.commands.registerCommand("raya.editReview.undoFile", (arg?: string) => void undo(arg)),
    vscode.commands.registerCommand("raya.editReview.keepFile", (arg?: string) => keep(arg)),
    vscode.window.onDidChangeVisibleTextEditors(() => applyAll()),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) apply(editor)
    }),
    vscode.workspace.onDidSaveTextDocument(() => refresh()),
  )

  return { refresh, dispose: () => decoration.dispose() }
}
