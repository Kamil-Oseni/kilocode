import path from "node:path"

/** Optional binding preserves legacy callers while fencing explicitly scoped Settings actions. */
export function bound(directory: unknown, current: string) {
  if (directory === undefined) return true
  if (typeof directory !== "string" || !directory || !path.isAbsolute(directory) || !current) return false
  const selected = path.resolve(directory)
  const actual = path.resolve(current)
  return process.platform === "win32" ? selected.toLowerCase() === actual.toLowerCase() : selected === actual
}
