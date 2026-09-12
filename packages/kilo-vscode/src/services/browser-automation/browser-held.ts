import { realpath } from "node:fs/promises"
import { resolve } from "node:path"

export function same(left: string, right: string) {
  const form = (value: string) => {
    const next = resolve(value)
      .replace(/^\\\\\?\\UNC\\/i, "\\\\")
      .replace(/^\\\\\?\\/i, "")
    if (process.platform === "win32") return next.replaceAll("/", "\\").toLowerCase()
    if (process.platform === "darwin") return next.toLowerCase()
    return next
  }
  return form(left) === form(right)
}

export async function held(path: string) {
  return same(await realpath(path), path)
}
