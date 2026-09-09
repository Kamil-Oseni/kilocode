import * as path from "node:path"
import * as vscode from "vscode"

export class UnsavedReview extends Error {
  constructor(file: string) {
    super(`Save or revert unsaved changes in ${file} before reviewing it.`)
    this.name = "UnsavedReview"
  }
}

export function failure(error: unknown, fallback: string) {
  if (error instanceof UnsavedReview) return error.message
  if (
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "ReviewConflict" &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message
  return fallback
}

/** Never implicitly save or discard an editor buffer as part of file review. */
export function assertSaved(directory: string, files?: readonly string[]) {
  const normalize = (file: string) => {
    const absolute = path.resolve(directory, file)
    return process.platform === "win32" ? absolute.toLowerCase() : absolute
  }
  const selected = files ? new Set(files.map(normalize)) : undefined
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || document.uri.scheme !== "file") continue
    const file = normalize(document.uri.fsPath)
    const relative = path.relative(normalize(directory), file)
    const included = selected
      ? selected.has(file)
      : relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    if (included) throw new UnsavedReview(path.basename(document.uri.fsPath))
  }
}
