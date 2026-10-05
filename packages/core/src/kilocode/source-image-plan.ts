import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { covers, type SourcePolicy } from "./source-policy"

type Root = Readonly<{ kind: "json" | "sqlite"; path: string }>
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
async function node(file: string) {
  return lstat(file, { bigint: true }).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
}

/** Planning records no authority. The native held namespace must validate this observation again. */
export async function plan(roots: readonly Root[], policy: SourcePolicy) {
  const selected = roots.map((root) => Object.freeze({ kind: root.kind, path: root.path }))
  const physical: { kind: "json" | "sqlite" | "negative"; path: string; missing: readonly string[] }[] = []
  const entries: { root: Root; namespace: string; missing: string[]; dev: bigint; ino: bigint; directory: boolean }[] =
    []
  for (const root of selected) {
    if (!path.isAbsolute(root.path) || path.normalize(root.path) !== root.path || !covers(policy, root.path))
      throw new Error("Offline selected root changed or is outside policy")
    const info = await node(root.path)
    if (info) {
      if (
        !same(await realpath(root.path), root.path) ||
        info.isSymbolicLink() ||
        (!info.isFile() && !info.isDirectory()) ||
        (info.isFile() && info.nlink !== 1n) ||
        (root.kind === "sqlite" && !info.isFile())
      )
        throw new Error("Offline selected object unsupported")
      if (info.isFile() && !covers(policy, path.dirname(root.path)))
        throw new Error("Offline file namespace parent requires declared directory policy")
      physical.push({ ...root, missing: [] })
      entries.push({
        root,
        namespace: root.path,
        missing: [] as string[],
        dev: info.dev,
        ino: info.ino,
        directory: info.isDirectory(),
      })
      continue
    }
    const missing = root.kind === "sqlite" ? [root.path, root.path + "-wal", root.path + "-shm"] : [root.path]
    for (const file of missing)
      if (await node(file)) throw new Error("Offline absent SQLite namespace retains a companion file")
    let parent = path.dirname(root.path)
    while (!(await node(parent))) {
      missing.push(parent)
      if (path.dirname(parent) === parent || missing.length > 128)
        throw new Error("Offline absence ancestor is unbounded")
      parent = path.dirname(parent)
    }
    const ancestor = await lstat(parent, { bigint: true })
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || !same(await realpath(parent), parent))
      throw new Error("Offline absent root lacks an authorized canonical namespace")
    // Only the declared absent child is authorized. The ancestor is held, never captured.
    entries.push({ root, namespace: parent, missing, dev: ancestor.dev, ino: ancestor.ino, directory: false })
  }
  for (const item of entries) {
    if (!item.missing.length) continue
    physical.push(Object.freeze({ kind: "negative", path: item.namespace, missing: Object.freeze(item.missing) }))
  }
  const captured = physical.filter(
    (root) =>
      root.kind !== "json" ||
      !entries.some(
        (entry) =>
          entry.directory &&
          !same(entry.root.path, root.path) &&
          root.path.toLowerCase().startsWith(`${entry.root.path.toLowerCase()}${path.sep}`),
      ),
  )
  return Object.freeze({
    roots: Object.freeze(captured.map((root) => Object.freeze(root))),
    entries: Object.freeze(entries.map((item) => Object.freeze({ ...item, missing: Object.freeze(item.missing) }))),
  })
}

/** Only call after the original native namespace and immutable stage are both held. */
export async function negative(entry: Awaited<ReturnType<typeof plan>>["entries"][number], staged: string) {
  const info = await lstat(entry.namespace, { bigint: true })
  if (info.dev !== entry.dev || info.ino !== entry.ino || !same(await realpath(entry.namespace), entry.namespace))
    throw new Error("Offline absence namespace changed before native acquisition")
  if (!(await lstat(staged)).isDirectory()) throw new Error("Offline staged negative namespace is absent")
  for (const file of entry.missing) {
    const relative = path.relative(entry.namespace, file)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Offline negative path escapes held namespace")
    if (await node(file)) throw new Error("Offline absent path appeared before native acquisition")
  }
  return Object.freeze({ namespace: entry.namespace, stagedNamespace: staged, missing: entry.missing })
}
