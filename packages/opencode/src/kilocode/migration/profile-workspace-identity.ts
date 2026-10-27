import path from "node:path"

export function syntax(file: string) {
  if (/^[a-z]:[\\/]/i.test(file) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(file)) return path.win32
  if (file.startsWith("/")) return path.posix
  throw new Error("Declared portable workspace reference must be absolute")
}

/** Source storage may use Windows forward slashes even when the destination uses another platform. */
export function identity(file: string) {
  if (!file || file.length > 4096 || file.includes("\0")) throw new Error("Invalid portable workspace reference")
  const api = syntax(file)
  const normalized = api.normalize(file)
  return api === path.win32 ? normalized.replaceAll("\\", "/").toLowerCase() : normalized
}
