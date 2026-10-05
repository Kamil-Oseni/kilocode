import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import z from "zod"

export const SourcePolicySchema = z
  .object({
    version: z.literal(1),
    directories: z.array(z.string().min(1).max(4096)).max(128),
    files: z.array(z.string().min(1).max(4096)).max(128),
  })
  .strict()
export type SourcePolicy = Readonly<{ version: 1; directories: readonly string[]; files: readonly string[] }>
const normalize = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
async function canonical(file: string): Promise<string> {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || file.includes("\0") || path.dirname(file) === file)
    throw new Error("Source policy path is not absolute, normalized and bounded below a volume root")
  return realpath(file).catch(async (err: unknown) => {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT" || path.dirname(file) === file) throw err
    return path.join(await canonical(path.dirname(file)), path.basename(file))
  })
}
function inside(parent: string, file: string) {
  const relative = path.relative(normalize(parent), normalize(file))
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

/** Pure containment: callers must obtain a physically validated producer policy first. */
export function covers(policy: SourcePolicy, file: string) {
  return (
    policy.files.some((value) => normalize(value) === normalize(file)) ||
    policy.directories.some((value) => inside(value, file))
  )
}

/** No directory creation, Global realization or writer registration occurs here. */
export async function validatePolicy(raw: unknown): Promise<SourcePolicy> {
  const value = SourcePolicySchema.parse(raw)
  if ((!value.directories.length && !value.files.length) || value.directories.length + value.files.length > 128)
    throw new Error("Source policy is empty or exceeded its bound")
  for (const values of [value.directories, value.files]) {
    const keys = values.map(normalize)
    if (new Set(keys).size !== keys.length || keys.some((key, index) => key !== [...keys].sort()[index]))
      throw new Error("Source policy paths are not ordered and distinct")
  }
  for (const directory of value.directories) {
    if (value.directories.some((other) => other !== directory && inside(other, directory)))
      throw new Error("Source policy contains redundant directory boundaries")
    if (normalize(await canonical(directory)) !== normalize(directory))
      throw new Error("Source policy directory identity changed")
    const info = await stat(directory).catch((err: unknown) => {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err
      return undefined
    })
    if (info && !info.isDirectory()) throw new Error("Source policy directory boundary is a file")
  }
  for (const file of value.files) {
    if (
      value.directories.some((directory) => inside(directory, file)) ||
      value.files.some((other) => other !== file && (inside(other, file) || inside(file, other)))
    )
      throw new Error("Source policy exact file boundary overlaps another boundary")
    if (normalize(await canonical(file)) !== normalize(file)) throw new Error("Source policy file identity changed")
    const info = await stat(file).catch((err: unknown) => {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err
      return undefined
    })
    if (info && (!info.isFile() || info.nlink !== 1))
      throw new Error("Source policy exact file is not a unique regular file")
  }
  return Object.freeze({
    version: 1,
    directories: Object.freeze(value.directories.map(normalize)),
    files: Object.freeze(value.files.map(normalize)),
  })
}
