// raya_change - new file
//
// Virtual review buffers for files that are no longer on disk. Deleted and
// renamed-from paths cannot use scheme "file", so in-editor Keep/Undo needs
// a content provider keyed to an opaque immutable review identity. Absolute
// workspace paths stay in the provider's private registry rather than leaking
// into serialized editor URIs.

import * as vscode from "vscode"

export const SCHEME = "raya-review"
export const UNAVAILABLE =
  "Raya cannot display this deleted file because its saved review data does not contain the original text."

export function uri(id: string, file: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${file.replace(/\\/g, "/")}`,
    query: id,
  })
}

export function decode(doc: vscode.Uri): string | undefined {
  if (doc.scheme !== SCHEME || !doc.query) return
  return doc.query
}
