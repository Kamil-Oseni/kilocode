import path from "node:path"
import { inventory, type Working } from "./profile-image"

type Root = Readonly<{ kind: "json" | "sqlite"; path: string }>
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
function relative(parent: string, file: string) {
  const value = path.relative(key(parent), key(file))
  if (path.isAbsolute(value) || value === ".." || value.startsWith(`..${path.sep}`)) return undefined
  return value
}

/** Authenticated owners require proof from the final live held image, not policy containment. */
export function assertCoverage(working: Working, roots: readonly Root[]) {
  const image = inventory(working)
  const files = new Set(image.files.map((file) => key(file.path)))
  const directories = new Map(image.directories?.map((dir) => [key(dir.path), dir]))
  const ancestors = image.roots.filter((root) => root.kind === "json" && root.directory && !root.absent)
  for (const root of roots) {
    if (image.roots.some((item) => item.kind === root.kind && key(item.path) === key(root.path))) continue
    const anchors = root.kind === "json" ? ancestors.filter((item) => relative(item.path, root.path) !== undefined) : []
    if (anchors.length && files.has(key(root.path))) continue
    if (anchors.length && image.directoryCoverage === "verified" && directories.has(key(root.path))) continue
    const absent =
      image.directoryCoverage === "verified" &&
      anchors.some((anchor) => {
        const suffix = relative(anchor.path, root.path)
        if (!suffix) return false
        const parts = suffix.split(path.sep)
        let current = anchor.path
        for (const [index, name] of parts.entries()) {
          const dir = directories.get(key(current))
          if (!dir) return false
          const child = dir.children.find((item) => key(item.name) === key(name))
          if (!child) return true
          if (!child.directory || index === parts.length - 1) return false
          current = path.join(current, name)
        }
        return false
      })
    if (absent) continue
    throw Object.assign(new Error("Acknowledged source root lacks final held image evidence"), {
      code: "RAYA_SOURCE_STATE_SCOPE_UNCOVERED",
    })
  }
}
