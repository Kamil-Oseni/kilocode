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
import { randomUUID } from "node:crypto"
import { fingerprint } from "./revision"
import { assertSaved, failure } from "./unsaved"
import { remember } from "./attempts"
import type { ReviewFileDiff } from "@kilocode/sdk/v2"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { addedRanges, deletionRanges, planReviewLenses, type LineRange } from "./patch-ranges"

export interface InEditorReviewDeps {
  readonly connection: Pick<KiloConnectionService, "getClient" | "getConnectionState">
  /** Currently active session id, or undefined. */
  readonly session: () => string | undefined
  /** Workspace directory the session's diff paths are relative to. */
  readonly directory: (sessionID?: string) => string
  /** Tell the chat review bar that an in-editor Keep/Undo happened. */
  readonly onFile?: (input: { sessionID: string; file: string; action: "keep" | "undo"; revision: string }) => void
}

interface FileReview {
  /** Path exactly as session.diff returned it — what discardChanges expects. */
  readonly file: string
  /** Resolved, normalized absolute path used to match open editors. */
  readonly abs: string
  readonly ranges: LineRange[]
  readonly revision: string
  readonly anchors: LineRange[]
  readonly summary: string
}

export interface InEditorReview extends vscode.Disposable {
  /** Re-derive highlights from the backend session diff. */
  refresh(): Promise<void>
  /** Hide every in-editor Keep/Undo cluster (chat Keep all / Undo all). */
  dismissAll(): void
  /** Capture the visible revision now; invoke only after server acknowledgement. */
  capture(session: string, files?: string[]): () => void
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
  let generation = 0
  let disposed = false
  const pending = new Set<string>()
  const attempts = new Map<string, string>()
  // Only acknowledged content is dismissed; identical line positions do not
  // identify an edit revision.
  const dismissed = new Map<string, string>()
  const print = (review: FileReview) => review.revision

  const build = (item: ReviewFileDiff, dir: string): FileReview | undefined => {
    if (!item.file || typeof item.patch !== "string") return
    const ranges = addedRanges(item.patch)
    const anchors = [...ranges, ...deletionRanges(item.patch)].sort((a, b) => a.start - b.start)
    const renamed = /^rename (?:from|to) /m.test(item.patch)
    const deleted = item.status === "deleted" || (!ranges.length && deletionRanges(item.patch).length > 0 && !renamed)
    if (!anchors.length && (renamed || deleted)) anchors.push({ start: 0, end: 0 })
    if (!anchors.length) return
    return {
      file: item.file,
      abs: norm(path.resolve(dir, item.file)),
      ranges,
      anchors,
      revision: fingerprint(item),
      summary: renamed ? "Renamed file" : deleted ? "Deleted file" : `${item.additions} added, ${item.deletions} removed in file`,
    }
  }

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

  const hydrate = (review: FileReview, revision: string | undefined) => {
    if (revision === undefined) return
    dismissed.delete(review.abs)
    if (revision === review.revision) dismissed.set(review.abs, review.revision)
  }

  async function reload() {
    const ticket = ++generation
    const next = deps.session()
    if (next !== sid) {
      sid = next
      dismissed.clear()
      attempts.clear()
      reviews.clear()
      applyAll()
      changes.fire()
    }
    const built = new Map<string, FileReview>()
    if (sid && deps.connection.getConnectionState() !== "connected") return
    if (sid) {
      const dir = deps.directory(sid)
      const res = await deps.connection
        .getClient()
        .session.diff({ sessionID: sid, directory: dir }, { throwOnError: true })
        .catch((err) => {
          console.error("[Raya] in-editor review diff failed:", err)
          return undefined
        })
      if (disposed || ticket !== generation || next !== deps.session()) return
      if (!res?.data) return
      for (const item of res.data) {
        const review = build(item, dir)
        if (!review) continue
        built.set(review.abs, review)
        hydrate(review, item.reviewed)
      }
    }
    if (disposed || ticket !== generation || next !== deps.session()) return
    reviews = built
    for (const [key, review] of built) {
      if (dismissed.get(key) && dismissed.get(key) !== print(review)) dismissed.delete(key)
    }
    applyAll()
    changes.fire()
  }

  const refresh = () => reload()
  const dismissAll = () => {
    for (const [key, review] of reviews) dismissed.set(key, print(review))
    applyAll()
    changes.fire()
  }
  const capture = (session: string, files?: string[]) => {
    const snapshot =
      sid === session
        ? new Map([...reviews].filter(([, review]) => !files || files.includes(review.file)))
        : new Map<string, FileReview>()
    return () => {
      if (disposed || sid !== session || deps.session() !== session) return
      for (const [key, review] of snapshot) {
        if (reviews.get(key)?.revision === review.revision) dismissed.set(key, review.revision)
      }
      applyAll()
      changes.fire()
    }
  }

  const reset = () => {
    dismissed.clear()
    applyAll()
    changes.fire()
  }

  const targetKey = (arg?: string) => arg ?? norm(vscode.window.activeTextEditor?.document.uri.fsPath ?? "")

  const identify = (key: string) => {
    const id = attempts.get(key) ?? randomUUID()
    attempts.set(key, id)
    return id
  }

  const acknowledge = (target: string, key: string, review: FileReview, action: "keep" | "undo") => {
    if (sid !== target || deps.session() !== target || reviews.get(key)?.revision !== review.revision) return
    dismissed.set(key, print(review))
    deps.onFile?.({ sessionID: target, file: review.file, action, revision: review.revision })
    applyAll()
    changes.fire()
  }

  const act = async (action: "keep" | "undo", arg?: string, revision?: string, session?: string) => {
    const key = targetKey(arg)
    const review = reviews.get(key)
    if (!review || !sid || sid !== deps.session() || deps.connection.getConnectionState() !== "connected") return
    if (revision !== review.revision || session !== sid) return
    const target = sid
    const directory = deps.directory(target)
    const token = `${target}\0${key}`
    if (pending.has(token)) return
    pending.add(token)
    changes.fire()
    try {
      assertSaved(directory, [review.file])
      const requestID = identify(`${token}\0${action}\0${review.revision}`)
      const attempt = await remember(context.workspaceState, {
        request: requestID,
        session: target,
        directory,
        action,
        files: [review.file],
        expected: { [review.file]: review.revision },
      })
      assertSaved(directory, [review.file])
      const client = deps.connection.getClient().session
      const input = {
        sessionID: target,
        directory,
        files: [review.file],
        expected: { [review.file]: review.revision },
        requestID: attempt.id,
      }
      const result = await (action === "undo"
        ? client.discardChanges(input, { throwOnError: true })
        : client.keepChanges(input, { throwOnError: true }))
      if (result.data?.id !== target) throw new Error("Review action returned no matching session acknowledgement")
      if (disposed) return
      if (!attempt.recovered) acknowledge(target, key, review, action)
      await attempt.complete()
    } catch (err) {
      console.error(`[Kilo New] in-editor ${action} failed:`, err)
      if (!disposed)
        void vscode.window.showErrorMessage(
          failure(
            err,
            `Raya: couldn't ${action} this file's changes. Review remains available; retry after reconnecting.`,
          ),
        )
    } finally {
      pending.delete(token)
      if (!disposed) {
        applyAll()
        changes.fire()
        refresh()
      }
    }
  }

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changes.event,
    provideCodeLenses(document) {
      const key = norm(document.uri.fsPath)
      const review = reviews.get(key)
      if (disposed || !review || dismissed.get(key) === print(review)) return []
      const line = Math.min(review.anchors[0].start, Math.max(0, document.lineCount - 1))
      if (deps.connection.getConnectionState() !== "connected")
        return [
          new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
            title: "Reconnect to review this file",
            command: "",
          }),
        ]
      if (pending.has(`${sid}\0${key}`))
        return [
          new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
            title: "$(sync~spin) Updating file review…",
            command: "",
          }),
        ]
      // One Keep/Undo cluster per contiguous changed region (see planReviewLenses),
      // so the affordance sits next to each hunk even though undo reverts the file.
      return planReviewLenses(review.anchors, key, review.summary).map(
        (lens) =>
          new vscode.CodeLens(
            new vscode.Range(
              Math.min(lens.line, Math.max(0, document.lineCount - 1)),
              0,
              Math.min(lens.line, Math.max(0, document.lineCount - 1)),
              0,
            ),
            {
              title: lens.title,
              command: lens.command,
              arguments: lens.command ? [key, review.revision, sid] : undefined,
              tooltip:
                lens.command === "raya.editReview.undoFile"
                  ? "Undo the latest unaccepted edit throughout this file without crossing its kept boundary."
                  : "Keep current edits throughout this file. Later Undo cannot cross this accepted boundary.",
            },
          ),
      )
    },
  }

  context.subscriptions.push(
    new vscode.Disposable(() => {
      disposed = true
      generation++
    }),
    decoration,
    changes,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lenses),
    vscode.commands.registerCommand("raya.editReview.undoFile", (arg?: string, revision?: string, session?: string) =>
      act("undo", arg, revision, session),
    ),
    vscode.commands.registerCommand("raya.editReview.keepFile", (arg?: string, revision?: string, session?: string) =>
      act("keep", arg, revision, session),
    ),
    vscode.window.onDidChangeVisibleTextEditors(() => applyAll()),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) apply(editor)
    }),
    vscode.workspace.onDidSaveTextDocument(() => refresh()),
  )

  return {
    refresh,
    dismissAll,
    capture,
    reset,
    dispose: () => {
      disposed = true
      generation++
      decoration.dispose()
    },
  }
}
