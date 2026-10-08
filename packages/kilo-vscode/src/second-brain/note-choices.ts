import { lstat, readdir, realpath } from "node:fs/promises"
import path from "node:path"

const restricted = new Set(["system", "archive", ".git", "health", "medical", "private", "sensitive"])
const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
const allowed = (name: string, linked: boolean) =>
  !linked &&
  !restricted.has(name.toLowerCase()) &&
  !restricted.has(path.parse(name).name.toLowerCase()) &&
  !/[\\<>:"|?*\x00-\x1f]/.test(name) &&
  !/[. ]$/.test(name)

/** Metadata-only choices. Native policy review still reads, hashes and approves the exact current sources. */
export async function choices(root: string) {
  if (!path.isAbsolute(root) || normalize(await realpath(root)) !== normalize(root))
    throw new Error("Select an ordinary canonical notes folder")
  const before = await lstat(root, { bigint: true })
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Select an ordinary notes folder")
  const queue = [root]
  const names: string[] = []
  let count = 0
  for (const dir of queue) {
    const rows = await readdir(dir, { withFileTypes: true })
    count += rows.length
    if (count > 4096 || queue.length > 512) throw new Error("Notes folder exceeds the review listing bound")
    for (const row of rows) {
      if (!allowed(row.name, row.isSymbolicLink())) continue
      const file = path.join(dir, row.name)
      const info = await lstat(file, { bigint: true })
      if (info.isSymbolicLink() || normalize(await realpath(file)) !== normalize(file)) continue
      if (info.isDirectory()) {
        queue.push(file)
        continue
      }
      if (!info.isFile() || info.nlink !== 1n || !row.name.toLowerCase().endsWith(".md")) continue
      names.push(path.relative(root, file).replaceAll("\\", "/"))
      if (names.length > 128) throw new Error("Review supports at most 128 eligible notes")
    }
  }
  const after = await lstat(root, { bigint: true })
  if (after.dev !== before.dev || after.ino !== before.ino || after.birthtimeNs !== before.birthtimeNs)
    throw new Error("Notes folder changed during listing")
  return Object.freeze(names.sort((left, right) => left.localeCompare(right)))
}
