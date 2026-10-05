import { lstat, open, realpath, stat } from "node:fs/promises"
import path from "node:path"

const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
async function exists(file: string) {
  return lstat(file).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
}
async function directory(file: string) {
  const resolved = await realpath(file)
  if (!(await stat(resolved)).isDirectory()) throw new Error("Git metadata target is not a directory")
  return resolved
}
async function text(file: string, optional = false) {
  const before = await exists(file)
  if (!before && optional) return undefined
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16384)
    throw new Error("Git metadata file is absent, aliased or unbounded")
  const handle = await open(file, "r")
  try {
    const first = await handle.stat()
    if (
      first.dev !== before.dev ||
      first.ino !== before.ino ||
      !first.isFile() ||
      first.nlink !== 1 ||
      first.size > 16384
    )
      throw new Error("Git metadata file changed before read")
    const bytes = Buffer.alloc(16385)
    let size = 0
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    const after = await lstat(file)
    if (
      size > 16384 ||
      after.dev !== first.dev ||
      after.ino !== first.ino ||
      after.size !== size ||
      after.isSymbolicLink() ||
      after.nlink !== 1
    )
      throw new Error("Git metadata file changed or exceeded bound")
    const value = bytes.subarray(0, size).toString("utf8")
    if (!Buffer.from(value).equals(bytes.subarray(0, size)) || value.includes("\0") || value.includes("\uFEFF"))
      throw new Error("Unsupported Git metadata text encoding")
    return value
  } finally {
    await handle.close()
  }
}
function pointer(value: string, label: string) {
  const line = value.replace(/\r?\n$/, "")
  if (!line || line.startsWith('"') || /[\r\n\0]/.test(line) || line !== line.trim())
    throw new Error(`Unsupported Git ${label} pointer`)
  return line
}
async function stores(source: string) {
  const roots = new Map<string, string>()
  const objects = new Map<string, string>()
  const visit = async (input: string, depth: number): Promise<void> => {
    const root = await directory(input)
    if (roots.has(key(root))) return
    if (depth > 32 || roots.size >= 256) throw new Error("Git object store inventory exceeded bound")
    roots.set(key(root), root)
    const config = await text(path.join(root, "config"), true)
    for (const match of (config ?? "").matchAll(
      /^\s*(refstorage|sparsecheckout|sparsecheckoutcone|sparse)\s*=\s*(.+)$/gim,
    )) {
      const setting = match[2]
        ?.trim()
        .replace(/\s+[;#].*$/, "")
        .replace(/^"|"$/g, "")
        .toLowerCase()
      if (setting !== "false" && setting !== "0" && !(match[1]?.toLowerCase() === "refstorage" && setting === "files"))
        throw new Error("Git reftable/sparse metadata requires an explicit portable mapping")
    }
    const format = config
      ?.match(/^\s*objectformat\s*=\s*(.+)$/im)?.[1]
      ?.trim()
      .replace(/\s+[;#].*$/, "")
      .replace(/^"|"$/g, "")
      .toLowerCase()
    if (format && format !== "sha1" && format !== "sha256") throw new Error("Unsupported Git object format")
    const object = await directory(path.join(root, "objects"))
    if (key(object) !== key(path.join(root, "objects")))
      throw new Error("Aliased Git object store requires an explicit mapping")
    objects.set(key(object), object)
    const alternate = await text(path.join(object, "info", "alternates"), true)
    if (!alternate) return
    const lines = alternate.split(/\r?\n/).filter(Boolean)
    if (lines.length > 64) throw new Error("Git alternates exceeded bound")
    for (const line of lines) {
      const target = await directory(path.resolve(object, pointer(line, "alternate")))
      if (key(path.basename(target)) !== "objects") throw new Error("Unsupported Git alternate object directory")
      await visit(path.dirname(target), depth + 1)
    }
  }
  await visit(source, 0)
  return { roots, objects }
}

/** Bare/common stores use the same bounded alternate parser as worktree planning. */
export async function discoverStore(input: string) {
  const directory = await realpath(input)
  const value = await stores(directory)
  return Object.freeze({
    directory,
    roots: Object.freeze([...value.roots.values()].sort((a, b) => key(a).localeCompare(key(b)))),
    objects: Object.freeze([...value.objects.values()].sort((a, b) => key(a).localeCompare(key(b)))),
  })
}

/** Read-only metadata collection. It executes no Git command, hook or profile service. */
export async function discoverGit(input: string, env: NodeJS.ProcessEnv = {}) {
  for (const name of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_INDEX_FILE",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_NAMESPACE",
    "GIT_SHALLOW_FILE",
    "GIT_REPLACE_REF_BASE",
  ])
    if (env[name]) throw new Error(`Explicit Git override ${name} requires a producer mapping`)
  const cwd = await directory(input)
  let current = cwd
  while (true) {
    const marker = path.join(current, ".git")
    const info = await exists(marker)
    if (info) {
      const admin = (await stat(marker)).isDirectory()
        ? await directory(marker)
        : await (async () => {
            const value = await text(marker)
            if (!value?.startsWith("gitdir: ")) throw new Error("Git worktree has no typed gitdir pointer")
            return directory(path.resolve(current, pointer(value.slice(8), "gitdir")))
          })()
      const head = await text(path.join(admin, "HEAD"))
      if (!head || !/^(?:ref: refs\/[^\s]+|[a-f0-9]{40}|[a-f0-9]{64})\r?\n?$/.test(head))
        throw new Error("Git metadata HEAD is invalid")
      const backlink = await text(path.join(admin, "commondir"), true)
      const common = backlink ? await directory(path.resolve(admin, pointer(backlink, "commondir"))) : admin
      const value = await stores(common)
      const roots = [...new Map([admin, ...value.roots.values()].map((file) => [key(file), file])).values()].sort(
        (a, b) => key(a).localeCompare(key(b)),
      )
      return Object.freeze({
        cwd,
        roots: Object.freeze(roots),
        metadata: Object.freeze({ directory: admin, common, objects: Object.freeze([...value.objects.values()]) }),
      })
    }
    const parent = path.dirname(current)
    if (parent === current) return Object.freeze({ cwd, roots: Object.freeze([] as string[]), metadata: undefined })
    current = parent
  }
}
