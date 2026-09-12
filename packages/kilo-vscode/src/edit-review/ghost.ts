// raya_change - new file
//
// Virtual review buffers for files that are no longer on disk. Deleted and
// renamed-from paths cannot use scheme "file", so in-editor Keep/Undo needs
// a content provider keyed to the same absolute review identity.

import * as vscode from "vscode"

export const SCHEME = "raya-review"

export function prior(patch: string): string {
  const lines: string[] = []
  let hunk = false
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "")
    if (line.startsWith("@@")) {
      hunk = true
      continue
    }
    if (!hunk) continue
    if (line.startsWith("-") && !line.startsWith("---")) {
      lines.push(line.slice(1))
      continue
    }
    if (line.startsWith(" ")) lines.push(line.slice(1))
  }
  return lines.join("\n")
}

export function uri(abs: string, file: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${file.replace(/\\/g, "/")}`,
    query: Buffer.from(abs).toString("base64url"),
  })
}

export function decode(doc: vscode.Uri): string | undefined {
  if (doc.scheme !== SCHEME || !doc.query) return
  return Buffer.from(doc.query, "base64url").toString()
}
