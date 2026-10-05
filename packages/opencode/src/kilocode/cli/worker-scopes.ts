import path from "node:path"
import { scopePaths } from "@opencode-ai/core/kilocode/source-scopes"

type Root = Readonly<{ kind: "sqlite" | "json"; path: string }>
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
function freeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}

/** Metadata only: every role must be backed by this exact confirmed participant's roots. */
export function workerScopes(input: unknown, roots: readonly Root[]) {
  if (input === undefined) return undefined
  const { value, paths, origins } = scopePaths(input)
  for (const state of [...paths, ...origins]) {
    if (
      !roots.some((root) => {
        if (root.kind !== "json") return false
        const relative = path.relative(key(root.path), key(state))
        return (
          relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        )
      })
    )
      throw new Error("Worker namespace scope lacks its participant's historical ownership")
  }
  return freeze(value)
}
