import { Schema } from "effect"
import * as fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"

export class Unsupported extends Error {}
export const Worktree = Schema.Struct({
  root: Schema.String,
  directory: Schema.String,
  branch: Schema.String,
  common: Schema.String,
  commit: Schema.String,
})
type Source = { root: string; commit: string }
type Plan = typeof Worktree.Type
type Pointer = { file: string; oid: string; size: number }
const same = (left: string, right: string) =>
  process.platform === "win32"
    ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
    : path.normalize(left) === path.normalize(right)
const inside = (root: string, value: string) => {
  const relative = path.relative(root, value)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}
const absent = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"
const failure = () =>
  new Error(
    "Repair checkout identity or configuration could not be verified. Inspect the retained attempt; do not retry creation automatically.",
  )

async function command(root: string, args: string[], input?: string) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  )
  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      "git",
      [
        "--no-pager",
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "submodule.recurse=false",
        "-c",
        "core.sparseCheckout=false",
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.smudge=",
        "-c",
        "filter.lfs.clean=",
        "-c",
        "filter.lfs.required=false",
        "-C",
        root,
        ...args,
      ],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "buffer",
        env: { ...inherited, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
    child.stdin?.on("error", reject)
    child.stdin?.end(input)
  })
}
async function git(root: string, args: string[], optional = false, input?: string) {
  try {
    const result = (await command(root, args, input)).toString("utf8")
    return args.includes("-z") ? result : result.trim()
  } catch (error) {
    if (optional && error && typeof error === "object" && "code" in error && error.code === 1) return ""
    throw failure()
  }
}
async function future(value: string): Promise<string> {
  try {
    return await fs.realpath(value)
  } catch (error) {
    if (!absent(error) || path.dirname(value) === value) throw failure()
    return path.join(await future(path.dirname(value)), path.basename(value))
  }
}

async function pointers(input: Source): Promise<Pointer[]> {
  const tree = (await git(input.root, ["ls-tree", "-r", "-z", input.commit]))
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const match = row.match(/^(\d+) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/)
      if (!match) throw failure()
      return { mode: match[1], type: match[2], oid: match[3], file: match[4] }
    })
  const attributes = (
    await git(
      input.root,
      ["check-attr", "-z", "--stdin", `--source=${input.commit}`, "filter"],
      false,
      tree.map((row) => row.file + "\0").join(""),
    )
  ).split("\0")
  const active = new Set<string>()
  for (let index = 0; index + 2 < attributes.length; index += 3) {
    const filter = attributes[index + 2]
    if (filter === "unspecified" || filter === "unset") continue
    if (filter !== "lfs")
      throw new Unsupported(
        "The admitted source uses an unsupported checkout filter. Repair preparation only materializes verified local LFS bytes; it never executes filter programs.",
      )
    active.add(attributes[index])
  }
  const rows = tree.filter((row) => active.has(row.file))
  if (rows.some((row) => row.type !== "blob" || !["100644", "100755"].includes(row.mode)))
    throw new Unsupported("An LFS path is not a regular committed file.")
  if (!rows.length) return []
  const objects = [...new Set(rows.map((row) => row.oid))]
  const headers = (
    await git(
      input.root,
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      false,
      objects.join("\n") + "\n",
    )
  ).split("\n")
  const small = headers
    .filter((row) => /^([0-9a-f]+) blob (\d+)$/.test(row) && Number(row.split(" ")[2]) <= 1024)
    .map((row) => row.split(" ")[0])
  if (headers.length !== objects.length || headers.some((row) => !/^([0-9a-f]+) blob (\d+)$/.test(row))) throw failure()
  if (small.length !== objects.length)
    throw new Unsupported("An LFS entry is not a canonical pointer within the supported size limit.")
  const bytes = await command(input.root, ["cat-file", "--batch"], small.join("\n") + "\n")
  const parsed = new Map<string, Omit<Pointer, "file">>()
  let offset = 0
  for (const oid of small) {
    const end = bytes.indexOf(10, offset)
    if (end < 0) throw failure()
    const header = bytes.subarray(offset, end).toString("ascii").split(" ")
    const size = Number(header[2])
    if (
      header[0] !== oid ||
      header[1] !== "blob" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 1024 ||
      end + size + 1 >= bytes.length
    )
      throw failure()
    const text = bytes.subarray(end + 1, end + 1 + size).toString("utf8")
    offset = end + size + 2
    if (!text.startsWith("version https://git-lfs.github.com/spec/v1"))
      throw new Unsupported("An LFS entry is not a canonical committed pointer.")
    const match = text.match(
      /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]*)\n?$/,
    )
    if (!match || !Number.isSafeInteger(Number(match[2])))
      throw new Unsupported("An admitted LFS pointer is not canonical or has an unsupported size.")
    parsed.set(oid, { oid: match[1], size: Number(match[2]) })
  }
  return rows.flatMap((row) => {
    const pointer = parsed.get(row.oid)
    return pointer ? [{ ...pointer, file: row.file }] : []
  })
}

async function matches(file: string, pointer: Pointer, root: string) {
  try {
    const canonical = await fs.realpath(file)
    const stat = await fs.lstat(file)
    if (!inside(root, canonical) || !stat.isFile() || stat.size !== pointer.size) return false
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest("hex") === pointer.oid
  } catch {
    return false
  }
}
async function content(input: Source, common: string, pointer: Pointer) {
  const root = path.join(common, "lfs", "objects")
  const cached = path.join(root, pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid)
  if (await matches(cached, pointer, root)) return cached
  const working = path.resolve(input.root, pointer.file)
  if (inside(input.root, working) && (await matches(working, pointer, input.root))) return working
  throw new Unsupported(
    "A committed LFS object is unavailable or fails its SHA-256/size check. Restore the verified object locally and inspect this attempt; no network fetch or filter program was run.",
  )
}

async function source(input: Source) {
  if (!path.isAbsolute(input.root) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.commit)) throw failure()
  const root = await fs.realpath(input.root)
  if (!same(root, input.root) || !same(await fs.realpath(await git(root, ["rev-parse", "--show-toplevel"])), root))
    throw failure()
  if (await git(root, ["config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor)$"], true))
    throw new Unsupported(
      "Repair checkout needs local complete objects. Partial-clone or promisor helpers are not supported for unattended preparation.",
    )
  if ((await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])) !== input.commit) throw failure()
  for (const [file, name] of [
    ["package.json", "@kilocode/kilo"],
    ["packages/opencode/package.json", "@kilocode/cli"],
    ["packages/kilo-vscode/package.json", "raya"],
  ]) {
    const target = await fs.realpath(path.join(root, file))
    if (!inside(root, target) || (await fs.stat(target)).size > 1024 * 1024) throw failure()
    const committed = JSON.parse(await git(root, ["show", `${input.commit}:${file}`]))
    const working = JSON.parse(await fs.readFile(target, "utf8"))
    if (
      committed.name !== name ||
      working.name !== name ||
      (name === "raya" && (committed.publisher !== "eden" || working.publisher !== "eden"))
    )
      throw failure()
  }
  return {
    common: await fs.realpath(path.resolve(root, await git(root, ["rev-parse", "--git-common-dir"]))),
    lfs: await pointers(input),
  }
}
function paths(input: Source, plan: Plan) {
  if (
    !same(path.dirname(plan.directory), plan.root) ||
    inside(input.root, plan.root) ||
    inside(plan.root, input.root) ||
    inside(plan.common, plan.root) ||
    inside(plan.root, plan.common)
  )
    throw failure()
}
async function boundary(input: Source, plan: Plan) {
  paths(input, plan)
  if (!same(await future(plan.root), plan.root)) throw failure()
  const inspected = await source(input)
  if (!same(inspected.common, plan.common) || input.commit !== plan.commit) throw failure()
  return inspected
}
export async function plan(input: Source, id: string, root: string): Promise<Plan> {
  if (!/^[0-9a-f-]{36}$/.test(id) || !path.isAbsolute(root) || !same(path.resolve(root), await future(root)))
    throw failure()
  const inspected = await source(input)
  const result = {
    root: path.resolve(root),
    directory: path.join(root, id),
    branch: `raya/repair/${id}`,
    common: inspected.common,
    commit: input.commit,
  }
  paths(input, result)
  const checked = new Set<string>()
  for (const pointer of inspected.lfs) {
    if (checked.has(pointer.oid)) continue
    await content(input, inspected.common, pointer)
    checked.add(pointer.oid)
  }
  return result
}
export async function verify(input: Source, plan: Plan) {
  const inspected = await boundary(input, plan)
  if (!same(await fs.realpath(plan.directory), plan.directory)) throw failure()
  if (!same(await fs.realpath(await git(plan.directory, ["rev-parse", "--show-toplevel"])), plan.directory))
    throw failure()
  if (
    !same(
      await fs.realpath(path.resolve(plan.directory, await git(plan.directory, ["rev-parse", "--git-common-dir"]))),
      plan.common,
    )
  )
    throw failure()
  if (
    (await git(plan.directory, ["rev-parse", "--verify", "HEAD^{commit}"])) !== plan.commit ||
    (await git(plan.directory, ["symbolic-ref", "HEAD"])) !== `refs/heads/${plan.branch}`
  )
    throw failure()
  const entries = (await git(input.root, ["worktree", "list", "--porcelain", "-z"]))
    .split("\0\0")
    .map((entry) => entry.split("\0"))
  if (
    !entries.some(
      (entry) =>
        entry.some((field) => field.startsWith("worktree ") && same(field.slice(9), plan.directory)) &&
        entry.includes(`HEAD ${plan.commit}`) &&
        entry.includes(`branch refs/heads/${plan.branch}`),
    )
  )
    throw failure()
  if (
    (await git(plan.directory, ["diff-index", "--cached", "--name-only", "-z", plan.commit])) ||
    (await git(plan.directory, ["ls-files", "--others", "-z"]))
  )
    throw failure()
  const materialized = new Set(inspected.lfs.map((pointer) => pointer.file))
  const dirty = (await git(plan.directory, ["diff-files", "--no-ext-diff", "--name-only", "-z"]))
    .split("\0")
    .filter(Boolean)
  if (dirty.some((file) => !materialized.has(file))) throw failure()
  for (const pointer of inspected.lfs)
    if (!(await matches(path.resolve(plan.directory, pointer.file), pointer, plan.directory))) throw failure()
}
export async function create(input: Source, plan: Plan) {
  await boundary(input, plan)
  if (
    await fs.lstat(plan.directory).then(
      () => true,
      (error) => {
        if (!absent(error)) throw failure()
        return false
      },
    )
  )
    throw failure()
  if (await git(input.root, ["for-each-ref", "--format=%(refname)", `refs/heads/${plan.branch}`])) throw failure()
  await fs.mkdir(plan.root, { recursive: true })
  await boundary(input, plan)
  await git(input.root, ["worktree", "add", "--no-checkout", "-b", plan.branch, plan.directory, plan.commit])
  const inspected = await boundary(input, plan)
  await git(plan.directory, ["read-tree", "--reset", "-u", plan.commit])
  for (const pointer of inspected.lfs) {
    const target = path.resolve(plan.directory, pointer.file)
    if (
      !inside(plan.directory, target) ||
      !inside(plan.directory, await fs.realpath(target)) ||
      !(await fs.lstat(target)).isFile()
    )
      throw failure()
    await fs.copyFile(await content(input, plan.common, pointer), target)
    if (!(await matches(target, pointer, plan.directory))) throw failure()
  }
  await verify(input, plan)
}
