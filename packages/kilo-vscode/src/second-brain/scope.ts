import path from "node:path"
import { isDeepStrictEqual } from "node:util"

type Workspace = { trusted: boolean; folders: readonly string[] }

/** Personal notes are independently selected; an empty trusted window needs no project grant. */
export function personal(project: string, current: () => Workspace) {
  const normalize = (folder: string) => path.resolve(folder).toLowerCase()
  const snapshot = () => {
    const value = current()
    return { trusted: value.trusted, folders: value.folders.map(normalize).sort() }
  }
  const original = snapshot()
  if (!original.trusted || (original.folders.length && !original.folders.includes(normalize(project))))
    throw new Error("Select an exact trusted workspace folder or a trusted empty window for personal Memory")
  return () => {
    if (!isDeepStrictEqual(snapshot(), original)) throw new Error("Original personal Memory window changed")
  }
}
