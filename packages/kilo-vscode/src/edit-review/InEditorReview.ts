// raya_change - new file
//
// In-editor agent-edit review. When the active session has uncommitted agent
// edits, this paints a green whole-line highlight on the changed lines *inside
// the edited file* and offers inline "Keep" / "Undo" CodeLens at the top of the
// change — so review no longer only lives in the separate "review changes"
// screen. Undo reuses the same per-file server op the webview uses
// (session.discardChanges with a single `files` entry); Keep dismisses the
// in-editor chrome for that file until a later edit in the same session.

import * as vscode from "vscode"
import * as path from "node:path"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { addedRanges, planReviewLenses, type LineRange } from "./patch-ranges"

export interface InEditorReviewDeps {
  readonly connection: KiloConnectionService
  /** Currently active session id, or undefined. */
  readonly session: () => string | undefined
  /** Workspace directory the session's diff paths are relative to. */
  readonly directory: (sessionID?: string) => string
  /** Tell the chat review bar that an in-editor Keep/Undo happened. */
  readonly onFile?: (input: { sessionID: string; file: string; action: "keep" | "undo" }) => void
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
  /** Hide every in-editor Keep/Undo cluster (chat Keep all / Undo all). */
  dismissAll(): void
  /** Forget Keep/Undo dismissals so a later edit in this session can show them again. */
  reset(): void
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
  // Optimistic hide keyed by the patch fingerprint that was dismissed. A later
  // edit of the same file produces a new fingerprint and must show Keep/Undo again.
  const dismissed = new Map<string, string>()
  const print = (review: FileReview) => review.ranges.map((r) => `${r.start}:${r.end}`).join(",")

  const apply = (editor: vscode.TextEditor) => {
    const key = norm(editor.document.uri.fsPath)
    const review = reviews.get(key)
    if (!review || dismissed.get(key) === print(review)) {
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
    for (const [key, review] of built) {
      if (dismissed.get(key) && dismissed.get(key) !== print(review)) dismissed.delete(key)
    }
    applyAll()
    changes.fire()
  }

  const refresh = () => void reload()
  const dismissAll = () => {
    for (const [key, review] of reviews) dismissed.set(key, print(review))
    applyAll()
    changes.fire()
  }

  const reset = () => {
    dismissed.clear()
    applyAll()
    changes.fire()
  }

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
    dismissed.set(key, print(review))
    applyAll()
    changes.fire()
    if (sid) deps.onFile?.({ sessionID: sid, file: review.file, action: "undo" })
    refresh()
  }

  const keep = (arg?: string) => {
    const key = targetKey(arg)
    const review = reviews.get(key)
    if (review) dismissed.set(key, print(review))
    applyAll()
    changes.fire()
    // raya_change - record a kept boundary for this file so a later Undo steps back only to
    // this accepted edit, never below it. Fire-and-forget; the local dismiss already updated UI.
    if (sid && review && deps.connection.getConnectionState() === "connected") {
      const target = sid
      deps.connection
        .getClient()
        .session.keepChanges({ sessionID: target, directory: deps.directory(target), files: [review.file] })
        .catch((err) => console.error("[Raya] in-editor keep failed:", err))
    }
    if (sid && review) deps.onFile?.({ sessionID: sid, file: review.file, action: "keep" })
  }

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changes.event,
    provideCodeLenses(document) {
      const key = norm(document.uri.fsPath)
      const review = reviews.get(key)
      if (!review || dismissed.get(key) === print(review)) return []
      // One Keep/Undo cluster per contiguous changed region (see planReviewLenses),
      // so the affordance sits next to each hunk even though undo reverts the file.
      return planReviewLenses(review.ranges, key).map(
        (lens) =>
          new vscode.CodeLens(new vscode.Range(lens.line, 0, lens.line, 0), {
            title: lens.title,
            command: lens.command,
            arguments: lens.arguments,
          }),
      )
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

  return { refresh, dismissAll, reset, dispose: () => decoration.dispose() }
}
