import { readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"

/** Keep recent recovery history and explicitly protected revisions of one artifact. */
export async function prune(directory: string, name: string, retain: (revision: string) => boolean) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Invalid canvas cache name.")
  const pattern = new RegExp(
    `^${name}\\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\\.(?:draft\\.json|js)$`,
  )
  const entries = await readdir(directory, { withFileTypes: true })
  const revisions = new Map<string, { time: number; files: string[] }>()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = pattern.exec(entry.name)
    if (!match) continue
    const path = join(directory, entry.name)
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) continue
    const revision = match[1]!
    const group = revisions.get(revision) ?? { time: 0, files: [] }
    group.time = Math.max(group.time, info.mtimeMs)
    group.files.push(path)
    revisions.set(revision, group)
  }
  const recent = [...revisions.entries()].sort((a, b) => b[1].time - a[1].time || a[0].localeCompare(b[0]))
  for (const [revision, group] of recent.slice(20)) {
    if (retain(revision)) continue
    for (const path of group.files) {
      if (retain(revision)) break
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
    }
  }
}
