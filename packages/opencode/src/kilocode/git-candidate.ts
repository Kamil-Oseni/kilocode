import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

// Conservative candidate detection, never proof that Git evidence is valid.
export async function candidate(directory: string) {
  if (Object.entries(process.env).some(([key, value]) => key.toUpperCase().startsWith("GIT_") && value)) return true
  const root = await realpath(directory).catch(() => undefined)
  if (!root) return true
  async function present(file: string) {
    return lstat(file).then(
      () => true,
      (err: unknown) => {
        if (err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return false
        return true // Defer unknown metadata errors to the unchanged Git validation.
      },
    )
  }
  let dir = root
  while (true) {
    if (await present(path.join(dir, ".git"))) return true
    if (
      (await present(path.join(dir, "HEAD"))) &&
      (await present(path.join(dir, "objects"))) &&
      (await present(path.join(dir, "refs")))
    )
      return true
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}
