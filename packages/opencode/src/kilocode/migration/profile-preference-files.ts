import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { sanitize } from "./profile-preferences"
import { read as bounded } from "./profile-file"

export type Files = { config?: string; modelState?: string; extensionState?: string }

/** Explicit selected files only. Directory authority does not establish complete config precedence or client coverage. */
export async function selected(
  input: Files | undefined,
  roots: readonly Readonly<{ kind: "json" | "sqlite"; path: string }>[],
) {
  async function read(file: string | undefined) {
    if (!file) return {}
    const canonical = await realpath(file)
    const key = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
    if (!roots.some((root) => root.kind === "json" && key(root.path) === key(path.dirname(canonical))))
      throw new Error("Selected preference file is outside declared canonical root")
    const stat = await lstat(canonical)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576)
      throw new Error("Unsupported selected preference file")
    const errors: ParseError[] = []
    const value: unknown = parse((await bounded(file, 1_048_576)).value, errors, { allowTrailingComma: true })
    if (errors.length) throw new Error("Invalid selected preference document")
    return value
  }
  return sanitize(await read(input?.config), {
    modelState: await read(input?.modelState),
    extensionState: await read(input?.extensionState),
  })
}
