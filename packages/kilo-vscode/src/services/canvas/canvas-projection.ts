import { randomUUID } from "node:crypto"
import { readFile, rename, unlink, writeFile } from "node:fs/promises"

/** Replace editable projections only while their saved contents and editor ownership still match. */
export async function reconcile(
  files: { path: string; before: string | undefined; after: string }[],
  current: () => boolean,
  writable: (path: string) => boolean,
) {
  const entries = files
    .filter((file) => file.before !== file.after)
    .map((file) => ({ ...file, temp: `${file.path}.${randomUUID()}.tmp` }))
  const matches = async () => {
    for (const file of files) {
      if (!current() || !writable(file.path)) return false
      const value = await readFile(file.path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (value !== file.before) return false
    }
    return current()
  }
  try {
    if (!(await matches())) return false
    for (const file of entries) await writeFile(file.temp, file.after, { flag: "wx" })
    if (!(await matches())) return false
    for (const file of entries) {
      if (!current() || !writable(file.path)) return false
      await rename(file.temp, file.path)
    }
    return true
  } finally {
    for (const file of entries) {
      await unlink(file.temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
    }
  }
}
