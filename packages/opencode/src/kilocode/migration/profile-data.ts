import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

/** The shipped JSON store lives under data/storage; an overridden DB can live elsewhere. */
export async function locate(storage: string, selected?: string) {
  const directory = await realpath(selected ?? path.dirname(await realpath(storage)))
  const info = await lstat(directory)
  if (!info.isDirectory()) throw new Error("Portable profile data root is not a directory")
  return Object.freeze({
    data: directory,
    memory: path.join(directory, "memory"),
    exports: path.join(directory, "session-export.db"),
  })
}
