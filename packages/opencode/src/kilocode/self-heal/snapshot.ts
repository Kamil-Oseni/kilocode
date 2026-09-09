import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const File = Schema.Struct({ path: Schema.String, digest: Hash, mode: Schema.Literals([420, 493]), size: Schema.Int })
export const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  digest: Hash,
  head: Schema.String,
  files: Schema.Array(File),
}).annotate({ identifier: "Raya.SelfHealSnapshot" })
export type Snapshot = typeof Snapshot.Type

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const same = (one: string, two: string) =>
  process.platform === "win32" ? one.toLowerCase() === two.toLowerCase() : one === two
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}
const fail = (message: string): never => {
  throw new Error(`Repair verification snapshot: ${message}`)
}

function config(file: string, data: Buffer) {
  if (!/(^|\/)\.npmrc$/i.test(file)) return
  const allowed = new Set([
    "enable-pre-post-scripts",
    "ignore-scripts",
    "save-exact",
    "save-prefix",
    "package-lock",
    "legacy-peer-deps",
    "strict-peer-dependencies",
    "auto-install-peers",
    "engine-strict",
    "fund",
    "audit",
    "strict-ssl",
    "registry",
  ])
  for (const line of data.toString("utf8").split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith("#") || text.startsWith(";")) continue
    const match = text.match(/^([\w-]+)\s*=\s*(.*?)\s*$/)
    if (!match || !allowed.has(match[1].toLowerCase()) || /\$\{|[\x00-\x08]/.test(match[2]))
      return fail(`unsupported or credential-bearing configuration in ${file}; it was not copied`)
    if (match[1].toLowerCase() === "registry") {
      const url = new URL(match[2])
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        return fail(`credential-bearing registry configuration in ${file}; it was not copied`)
      continue
    }
    if (
      !(match[1].toLowerCase() === "save-prefix"
        ? /^["']?[~^]?["']?$/.test(match[2])
        : /^(true|false)$/i.test(match[2]))
    )
      return fail(`unsupported configuration value in ${file}; it was not copied`)
  }
}

async function git(root: string, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")))
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      [
        "--no-pager",
        ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=",
        "-C",
        root,
        ...args,
      ],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
      },
      (error, output) => (error ? reject(error) : resolve(output)),
    )
  })
}

function target(root: string, file: string) {
  if (
    !file ||
    file.includes("\\") ||
    file.includes("\0") ||
    file.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    return fail("unsupported source path")
  const resolved = path.resolve(root, file)
  if (!inside(root, resolved)) return fail("source path escapes its root")
  return resolved
}

async function bytes(root: string, file: string) {
  const resolved = target(root, file)
  const stat = await fs.lstat(resolved)
  if (!stat.isFile() || !same(await fs.realpath(resolved), resolved))
    return fail("symlink or nonregular source inputs need explicit support")
  if (stat.size > 256 * 1024 * 1024) return fail("source file exceeds the 256 MiB capture limit")
  const data = await fs.readFile(resolved)
  const after = await fs.lstat(resolved)
  if (
    stat.ino !== after.ino ||
    stat.size !== after.size ||
    stat.mtimeMs !== after.mtimeMs ||
    stat.ctimeMs !== after.ctimeMs ||
    !same(await fs.realpath(resolved), resolved)
  )
    return fail("source changed during capture")
  return { data, mode: (stat.mode & 0o111 ? 493 : 420) as 420 | 493 }
}

async function publish(root: string, digest: string, data: Uint8Array) {
  await folder(root)
  const file = path.join(root, digest)
  await fs.writeFile(file, data, { flag: "wx", mode: 0o600 }).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
  })
  if (
    !(await fs.lstat(file)).isFile() ||
    !same(await fs.realpath(file), file) ||
    hash(await fs.readFile(file)) !== digest
  )
    return fail("retained content is corrupt or redirected")
}

async function folder(root: string): Promise<void> {
  const stat = await fs.lstat(root).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (stat) {
    if (!stat.isDirectory() || !same(await fs.realpath(root), root)) return fail("snapshot storage is redirected")
    return
  }
  await folder(path.dirname(root))
  await fs.mkdir(root).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
  })
  if (!(await fs.lstat(root)).isDirectory() || !same(await fs.realpath(root), root))
    return fail("snapshot storage changed during creation")
}

/** Capture raw working bytes, without checkout filters, hooks, ignored files, or credential configuration. */
export async function capture(
  directory: string,
  store?: string,
  owner?: { common: string; commit: string },
): Promise<Snapshot> {
  const root = await fs.realpath(directory)
  if (store && (!path.isAbsolute(store) || inside(root, store) || inside(store, root)))
    return fail("snapshot storage must be separate from repair source")
  if (
    !same(root, path.resolve(directory)) ||
    !same((await git(root, ["rev-parse", "--show-toplevel"])).trim().replaceAll("/", path.sep), root)
  )
    return fail("source root is not its authoritative Git checkout")
  if (owner) {
    const common = await fs.realpath(path.resolve(root, (await git(root, ["rev-parse", "--git-common-dir"])).trim()))
    if (!same(common, owner.common)) return fail("Git ownership changed")
    await git(root, ["merge-base", "--is-ancestor", owner.commit, "HEAD"])
  }
  const read = async () => {
    const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim()
    const index = await git(root, ["ls-files", "--stage", "-z"])
    if (index.split("\0").some((row) => row.startsWith("160000 ") || (row && !/^[0-9]+ [a-f0-9]+ 0\t/.test(row))))
      return fail("submodules or an unmerged index require explicit snapshot support")
    const modes = new Map(
      index
        .split("\0")
        .filter(Boolean)
        .map((row) => [row.slice(row.indexOf("\t") + 1), row.startsWith("100755 ") ? (493 as const) : (420 as const)]),
    )
    const names = [
      ...new Set(
        (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean),
      ),
    ].sort()
    if (names.length > 100_000) return fail("source exceeds the 100,000-file capture limit")
    const files: Array<typeof File.Type> = []
    let size = 0
    for (const file of names) {
      if (
        /(^|\/)(\.env(?:\.[^/]+)?|\.yarnrc(?:\.yml)?|\.git-credentials|id_rsa|id_ed25519)$/i.test(file) &&
        !/\.(example|sample|template)$/i.test(file)
      )
        return fail(`credential-shaped source input ${file} needs explicit review; it was not copied`)
      const input = await bytes(root, file).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
        throw error
      })
      if (!input) continue // A tracked deletion is represented by absence in the captured tree.
      config(file, input.data)
      size += input.data.length
      if (size > 1024 * 1024 * 1024) return fail("source exceeds the 1 GiB capture limit")
      if (
        input.data.length < 1024 &&
        input.data.toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1\n")
      )
        return fail("an LFS pointer is not materialized; restore verified local bytes before checking")
      const digest = hash(input.data)
      files.push({
        path: file,
        digest,
        mode: process.platform === "win32" ? (modes.get(file) ?? input.mode) : input.mode,
        size: input.data.length,
      })
      if (store) await publish(path.join(store, "blobs"), digest, input.data)
    }
    return { head, files }
  }
  const first = await read()
  const second = await read()
  if (JSON.stringify(first) !== JSON.stringify(second)) return fail("source changed across capture")
  const snapshot: Snapshot = { version: 1, digest: hash(JSON.stringify(first)), ...first }
  if (store)
    await publish(path.join(store, "manifests"), hash(JSON.stringify(snapshot)), Buffer.from(JSON.stringify(snapshot)))
  return snapshot
}

/** Create private regular files. No links to mutable source or ignored dependency/credential directories. */
export async function materialize(store: string, snapshot: Snapshot) {
  if (snapshot.digest !== hash(JSON.stringify({ head: snapshot.head, files: snapshot.files })))
    return fail("invalid manifest identity")
  const directory = path.join(store, "runs", randomUUID())
  await folder(directory)
  for (const file of snapshot.files) {
    const blob = path.join(store, "blobs", file.digest)
    if (!(await fs.lstat(blob)).isFile() || !same(await fs.realpath(blob), blob))
      return fail("retained blob is redirected")
    const data = await fs.readFile(blob)
    if (hash(data) !== file.digest || data.length !== file.size)
      return fail("retained blob does not match the manifest")
    const output = target(directory, file.path)
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.writeFile(output, data, { flag: "wx", mode: file.mode })
  }
  // Empty private Git metadata provides ignore-aware output inspection, without checkout hooks or filters.
  await git(directory, ["init", "--quiet", "--template="])
  return directory
}

/** End-point observation only: commands can write this checkout, including transient writes. */
export async function unchanged(directory: string, snapshot: Snapshot) {
  for (const file of snapshot.files) {
    const input = await bytes(directory, file.path)
    if (hash(input.data) !== file.digest || (process.platform !== "win32" && input.mode !== file.mode))
      return fail("captured source changed in the verification checkout")
  }
  const expected = new Set(snapshot.files.map((file) => file.path))
  const names = (await git(directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
  if (names.some((file) => !expected.has(file))) return fail("verification created additional nonignored source inputs")
}
