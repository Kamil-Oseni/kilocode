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

/** Explicit native target selections only; binding metadata never publishes a note. */
export async function targets(
  root: string,
  project: string,
  input: readonly { key: string; path: string }[],
  authorize: () => void,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  authorize()
  if (!path.isAbsolute(root) || !path.isAbsolute(project) || input.length < 1 || input.length > 8)
    throw new Error("Pick one to eight Dream note targets")
  const selected = input.map((item) => {
    if (!path.isAbsolute(item.path)) throw new Error("Pick absolute note target paths")
    return { key: item.key, path: path.relative(root, item.path).replaceAll(path.sep, "/") }
  })
  const result = []
  for (const item of selected) {
    signal.throwIfAborted()
    authorize()
    result.push({ key: item.key, ...(await MemoryFiles.dreamInput.baseline(root, item.path, signal)) })
  }
  signal.throwIfAborted()
  authorize()
  const saved = await MemoryFiles.dream.bind(root, project, selected, signal)
  signal.throwIfAborted()
  authorize()
  return { scope: saved.scope, targets: result }
}
