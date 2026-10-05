import { lstat } from "node:fs/promises"
import { read } from "./profile-file"
import path from "node:path"
import { payload, snapshot } from "./profile-bundle"

/** Flatten previous transfers once by source identity; archived rows never become destination rows. */
export async function historical(root: string) {
  const file = path.join(root, "restore-source.json")
  const stat = await lstat(file).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  if (!stat) return []
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024)
    throw new Error("Unsupported archived profile evidence")
  const value = payload.parse(JSON.parse((await read(file, 128 * 1024 * 1024, 128 * 1024 * 1024)).value))
  const { archives, ...source } = value
  return [...archives, snapshot.parse(source)]
}
