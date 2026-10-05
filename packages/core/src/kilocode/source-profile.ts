import path from "node:path"
import { realpath, stat } from "node:fs/promises"
import { validatePolicy } from "./source-policy"
import { discoverGit } from "./git-roots"

async function canonical(file: string): Promise<string> {
  const resolved = path.normalize(file)
  return realpath(resolved).catch(async (err: unknown) => {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT" || path.dirname(resolved) === resolved)
      throw err
    return path.join(await canonical(path.dirname(resolved)), path.basename(resolved))
  })
}
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
const inside = (parent: string, file: string) => {
  const relative = path.relative(key(parent), key(file))
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

/** Read-only producer plan. It imports no Global service and creates no profile paths. */
export async function prepare(input: { home: string; cwd: string; env: NodeJS.ProcessEnv }) {
  if (!path.isAbsolute(input.home) || !path.isAbsolute(input.cwd))
    throw new Error("Source profile producer paths must be absolute")
  const clean = (value: string) => value.replace(/[\r\n]+/g, "")
  const home = clean(input.home)
  const legacy = (input.env.KILO_TEST_HOME ?? home).trim()
  if (!path.isAbsolute(legacy)) throw new Error("Source profile compatibility home must be absolute")
  const base = (name: string, fallback: string) => {
    const value = clean(input.env[name] || fallback)
    if (!path.isAbsolute(value)) throw new Error("Source profile XDG root must be absolute")
    return path.normalize(value)
  }
  const data = path.join(base("XDG_DATA_HOME", path.join(home, ".local/share")), "kilo")
  const cache = path.join(base("XDG_CACHE_HOME", path.join(home, ".cache")), "kilo")
  const config = path.join(base("XDG_CONFIG_HOME", path.join(home, ".config")), "kilo")
  const state = base("XDG_STATE_HOME", path.join(home, ".local/state"))
  const dirs: string[] = []
  const files: string[] = []
  const git = await discoverGit(input.cwd, input.env)
  dirs.push(git.cwd, ...git.roots)
  async function directory(file: string, compatible = false) {
    const resolved = await canonical(file)
    const existing = await stat(resolved).catch((err: unknown) => {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
    if (existing && !existing.isDirectory()) {
      if (!compatible || !existing.isFile()) throw new Error("Source profile directory is occupied by a file")
      files.push(resolved)
      return
    }
    dirs.push(resolved)
  }
  for (const file of [data, cache, config]) await directory(file)
  await directory(state, !input.env.XDG_STATE_HOME)
  for (const file of [path.join(legacy, ".kilocode"), path.join(legacy, ".config/kilo")]) await directory(file, true)
  const alias = (name: string) => input.env[`RAYA_${name}`] ?? input.env[`KILO_${name}`]
  for (const name of ["CONFIG_DIR", "LANCEDB_PATH"]) {
    const value = alias(name)
    if (!value) continue
    if (!path.isAbsolute(value)) throw new Error("Injected source profile directory must be absolute")
    await directory(path.normalize(value))
  }
  for (const name of ["DB", "MODELS_PATH"]) {
    const value = alias(name)
    if (!value || value === ":memory:") continue
    const file = path.resolve(input.cwd, value)
    await directory(path.dirname(file))
    files.push(await canonical(file))
  }
  const directories = [...new Map(dirs.map((file) => [key(file), key(file)])).values()]
    .sort()
    .filter((file, _, all) => !all.some((other) => other !== file && inside(other, file)))
  const exact = [...new Set(files.map(key))].sort().filter((file) => !directories.some((dir) => inside(dir, file)))
  const policy = await validatePolicy({ version: 1, directories, files: exact })
  const roots = Object.freeze([Object.freeze({ kind: "json" as const, path: key(await canonical(data)) })])
  return Object.freeze({ policy, roots })
}
