import path from "node:path"
import { MemoryFiles } from "@kilocode/kilo-memory/store"

/** Native file-picker results only. No directory scan or classification of new daily activity. */
export async function picked(
  project: string,
  files: readonly string[],
  kind: "approved-note" | "approved-summary",
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  if (!path.isAbsolute(project) || files.length < 1 || files.length > 8)
    throw new Error("Pick one to eight approved Markdown sources")
  const names = files.map((file) => {
    if (!path.isAbsolute(file)) throw new Error("Pick absolute source file paths")
    return path.relative(project, file).replaceAll(path.sep, "/")
  })
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length)
    throw new Error("Duplicate Dream source selection")
  const result = []
  for (const name of names) {
    const source = await MemoryFiles.dreamInput.inspect(project, name, signal)
    result.push({ path: source.path, sha256: source.sha256, kind })
  }
  return result
}
