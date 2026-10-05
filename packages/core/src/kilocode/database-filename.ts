import { existsSync, realpathSync } from "node:fs"
import path from "node:path"

/** Pin path selection before preflight/native construction; this does not pin an OS file identity. */
export function canonical(filename: string): string {
  if (filename === ":memory:") return filename
  const resolve = (file: string): string => {
    if (existsSync(file)) return realpathSync(file)
    const parent = path.dirname(file)
    if (parent === file) return realpathSync(file)
    return path.join(resolve(parent), path.basename(file))
  }
  return resolve(path.resolve(filename))
}
