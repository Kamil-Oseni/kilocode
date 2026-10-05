import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { covers, type SourcePolicy } from "@opencode-ai/core/kilocode/source-policy"
import type { Transfer } from "@opencode-ai/core/kilocode/source-transfer"
import { locate } from "./profile-data"

type Root = Readonly<{ kind: "sqlite" | "json"; path: string }>
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)

/** Canonical selected payload roots only; this planning step grants no capture authority. */
export async function select(input: Transfer["profile"], policy: SourcePolicy) {
  const roots = new Map<string, Root>()
  async function admit(kind: Root["kind"], file: string, directory: boolean) {
    const canonical = await realpath(file)
    const info = await lstat(canonical)
    if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
      throw new Error("Selected profile object has an unsupported type or alias")
    if (!covers(policy, canonical) || (!directory && !covers(policy, path.dirname(canonical))))
      throw new Error("Selected profile namespace escapes producer policy")
    roots.set(`${kind}:${key(canonical)}`, Object.freeze({ kind, path: canonical }))
    return canonical
  }
  const database = await admit("sqlite", input.database, false)
  const storage = await admit("json", input.storage, true)
  const located = await locate(storage, input.data)
  const data = await admit("json", located.data, true)
  const preferences: NonNullable<Transfer["profile"]["preferences"]> = {}
  for (const name of ["config", "modelState", "extensionState"] as const) {
    const file = input.preferences?.[name]
    if (!file) continue
    const canonical = await realpath(file)
    const info = await lstat(canonical)
    if (!info.isFile() || info.nlink !== 1 || !covers(policy, canonical))
      throw new Error("Selected preference file is unsupported or outside producer policy")
    await admit("json", path.dirname(canonical), true)
    preferences[name] = canonical
  }
  const file = input.exports ?? located.exports
  const info = await lstat(file).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT" && !input.exports) return undefined
    throw err
  })
  const exports = info ? await admit("sqlite", file, false) : undefined
  return Object.freeze({
    roots: Object.freeze([...roots.values()]),
    profile: Object.freeze({ database, storage, data, preferences: Object.freeze(preferences), exports }),
  })
}
