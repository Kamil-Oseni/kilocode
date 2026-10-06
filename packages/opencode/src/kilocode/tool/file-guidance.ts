/** Keep file data distinct from the presentation returned by file tools. */
export function description(id: string, value: string) {
  if (id !== "read" && id !== "write" && id !== "edit") return value
  return `${value}\n\nFile content and verification: Read output is a rendered view, not raw file bytes. Outer display line-number prefixes, XML wrappers, end-of-file/truncation footers and system reminders are presentation, not file content. Do not copy these decorations into write.content or edit.oldString/newString. Preserve actual file text that itself resembles a prefix or wrapper; do not automatically strip file data. A rendered view does not establish original newline endings, final newline or encoding. Do not claim byte-for-byte equality from the rendered view or an invented hash. Use actual captured file byte counts and hashes or other exact file evidence; when that evidence is unavailable, say exact byte equality is unverified. Read the saved target after a mutation and report any mismatch or unavailable verification instead of claiming success.`
}

export * as FileGuidance from "./file-guidance"
