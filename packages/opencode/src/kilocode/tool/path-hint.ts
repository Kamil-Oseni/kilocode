import path from "path"

export function duplicates(input: string, platform = process.platform) {
  const api = platform === "win32" ? path.win32 : path.posix
  const root = api.parse(input).root
  const parts = input.slice(root.length).split(api.sep)
  const same = (a: string, b: string) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b)
  return parts.flatMap((part, index) => {
    if (index === 0 || !same(parts[index - 1], part)) return []
    return [api.join(root, ...parts.filter((_, offset) => offset !== index))]
  })
}

export * as PathHint from "./path-hint"
