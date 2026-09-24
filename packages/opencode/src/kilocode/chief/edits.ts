import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { isUtf8 } from "node:buffer"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

/** Read-only, bounded evidence for reviewing one isolated edit worktree. */
export namespace ChiefEdits {
  export type File = {
    path: string
    status: string
    untracked: boolean
    conflict: boolean
    binary: boolean | undefined
    truncated: boolean
    patch: string | undefined
  }

  export type Preview = {
    directory: string
    baseCommit: string
    digest: string | undefined
    files: File[]
    conflicts: string[]
    truncated: boolean
    clean: boolean
  }

  export type Content = {
    sha256: string
    size: number
    type: "file"
    mode: "100644" | "100755"
  }

  export type Entry = {
    path: string
    base: Content | null
    final: Content | null
  }

  export type Manifest = {
    directory: string
    baseCommit: string
    previewDigest: string
    digest: string
    files: Entry[]
  }

  function git(dir: string, args: string[], limit = 1024 * 1024) {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "buffer",
      timeout: 15_000,
      maxBuffer: limit + 1,
      windowsHide: true,
      env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    })
    const truncated = result.error?.message.includes("ENOBUFS") ?? false
    if (result.error && !truncated) throw new Error(`Git inspection failed: ${result.error.message}`)
    if (!truncated && result.status !== 0)
      throw new Error(`Git inspection failed: ${result.stderr.toString("utf8").trim() || args.join(" ")}`)
    return { bytes: result.stdout ?? Buffer.alloc(0), truncated }
  }

  function names(bytes: Buffer) {
    if (bytes.length && bytes.at(-1) !== 0) throw new Error("Incomplete Git path listing")
    return bytes.toString("utf8").split("\0").filter(Boolean)
  }

  function inside(dir: string, name: string) {
    if (!name || path.isAbsolute(name) || name.includes("\0")) throw new Error("Invalid edit path")
    const relative = path.relative(dir, path.resolve(dir, name))
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Edit path escapes its worktree")
    return relative.split(path.sep).join("/")
  }

  /** A capped or conflicted preview is evidence for review, never an approval to integrate. */
  export async function preview(input: {
    directory: string
    baseCommit: string
    maxFiles?: number
    maxBytes?: number
  }): Promise<Preview> {
    const dir = await realpath(input.directory)
    const root = git(dir, ["rev-parse", "--show-toplevel"]).bytes.toString("utf8").trim()
    if (path.normalize(await realpath(root)).toLowerCase() !== path.normalize(dir).toLowerCase())
      throw new Error("Edit preview requires the worktree root")
    if (!/^[0-9a-f]{40,64}$/i.test(input.baseCommit)) throw new Error("Invalid fixed base commit")
    const base = git(dir, ["rev-parse", "--verify", `${input.baseCommit}^{commit}`])
      .bytes.toString("utf8")
      .trim()
    if (base.toLowerCase() !== input.baseCommit.toLowerCase()) throw new Error("Fixed base commit changed")
    const maxFiles = Math.max(1, Math.min(input.maxFiles ?? 100, 1000))
    const maxBytes = Math.max(1024, Math.min(input.maxBytes ?? 256 * 1024, 1024 * 1024))
    const tracked = git(dir, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-status",
      "-z",
      base,
      "--",
    ])
    const others = git(dir, ["ls-files", "--others", "--exclude-standard", "-z"])
    const merged = git(dir, ["ls-files", "--unmerged", "-z"])
    if (tracked.truncated || others.truncated || merged.truncated)
      throw new Error("Git path listing exceeded the review limit")
    const changes = names(tracked.bytes)
    if (changes.length % 2) throw new Error("Incomplete tracked path listing")
    const map = new Map<string, { status: string; untracked: boolean }>()
    for (let i = 0; i < changes.length; i += 2)
      map.set(inside(dir, changes[i + 1]!), { status: changes[i]!, untracked: false })
    for (const name of names(others.bytes)) {
      const key = inside(dir, name)
      if (!map.has(key)) map.set(key, { status: "?", untracked: true })
    }
    const conflicts = new Set<string>()
    for (const entry of names(merged.bytes)) {
      const tab = entry.indexOf("\t")
      if (tab < 0) throw new Error("Invalid conflict listing")
      conflicts.add(inside(dir, entry.slice(tab + 1)))
    }
    for (const name of conflicts) if (!map.has(name)) map.set(name, { status: "U", untracked: false })
    const paths = [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const files: File[] = []
    let remaining = maxBytes
    for (const name of paths.slice(0, maxFiles)) {
      const meta = map.get(name)!
      const conflict = conflicts.has(name)
      if (conflict || remaining <= 0) {
        files.push({
          path: name,
          status: meta.status,
          untracked: meta.untracked,
          conflict,
          binary: undefined,
          truncated: remaining <= 0,
          patch: undefined,
        })
        continue
      }
      if (meta.untracked) {
        const file = path.join(dir, name)
        const stat = await lstat(file)
        if (!stat.isFile()) {
          files.push({
            path: name,
            status: meta.status,
            untracked: true,
            conflict,
            binary: undefined,
            truncated: false,
            patch: undefined,
          })
          continue
        }
        const target = await realpath(file)
        inside(dir, path.relative(dir, target))
        const bytes = Buffer.from(
          await Bun.file(file)
            .slice(0, remaining + 1)
            .arrayBuffer(),
        )
        const truncated = stat.size > remaining || bytes.length > remaining
        const binary = bytes.includes(0) || !isUtf8(bytes)
        const patch = truncated || binary ? undefined : bytes.toString("utf8")
        remaining -= Math.min(bytes.length, remaining)
        files.push({ path: name, status: meta.status, untracked: true, conflict, binary, truncated, patch })
        continue
      }
      const result = git(
        dir,
        ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", base, "--", name],
        remaining,
      )
      const bytes = result.bytes
      const truncated = result.truncated || bytes.length > remaining
      const binary = truncated
        ? undefined
        : bytes.includes(Buffer.from("GIT binary patch")) ||
          bytes.includes(Buffer.from("Binary files")) ||
          !isUtf8(bytes) ||
          /^(?:old mode|new mode|deleted file mode|new file mode|index) .*\b(?:120000|160000)\b/m.test(
            bytes.toString("utf8").split("\n@@")[0] ?? "",
          )
      const patch = truncated || binary ? undefined : bytes.toString("utf8")
      remaining -= Math.min(bytes.length, remaining)
      files.push({ path: name, status: meta.status, untracked: false, conflict, binary, truncated, patch })
    }
    const truncated = paths.length > maxFiles || files.some((file) => file.truncated)
    const complete =
      !truncated && !conflicts.size && files.every((file) => file.patch !== undefined && file.binary === false)
    return {
      directory: dir,
      baseCommit: base,
      digest: complete ? createHash("sha256").update(JSON.stringify({ base, files })).digest("hex") : undefined,
      files,
      conflicts: [...conflicts].sort(),
      truncated,
      clean: paths.length === 0,
    }
  }

  /** Capture exact regular-file content identities only after a complete human-reviewable preview. */
  export async function manifest(input: { preview: Preview; maxBlobBytes?: number }): Promise<Manifest> {
    const first = input.preview
    if (
      !first.digest ||
      first.truncated ||
      first.conflicts.length ||
      first.files.some((file) => file.patch === undefined || file.binary !== false || file.truncated || file.conflict)
    )
      throw new Error("Edit preview is incomplete or contains unsupported content")
    const dir = await realpath(first.directory)
    const root = git(dir, ["rev-parse", "--show-toplevel"]).bytes.toString("utf8").trim()
    if (path.normalize(await realpath(root)).toLowerCase() !== path.normalize(dir).toLowerCase())
      throw new Error("Edit manifest requires the worktree root")
    const limit = Math.max(1024, Math.min(input.maxBlobBytes ?? 16 * 1024 * 1024, 32 * 1024 * 1024))
    const files: Entry[] = []
    for (const file of first.files) {
      const name = inside(dir, file.path)
      const tree = git(dir, ["ls-tree", "-z", first.baseCommit, "--", name]).bytes
      const items = names(tree)
      if (items.length > 1) throw new Error(`Ambiguous base path: ${name}`)
      const base = (() => {
        if (!items.length) return null
        const match = items[0]!.match(/^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/)
        if (!match || match[4] !== name) throw new Error(`Invalid base tree entry: ${name}`)
        if (match[2] !== "blob" || (match[1] !== "100644" && match[1] !== "100755"))
          throw new Error(`Unsupported base file type: ${name}`)
        const result = git(dir, ["cat-file", "blob", match[3]!], limit)
        if (result.truncated || result.bytes.length > limit)
          throw new Error(`Base file exceeds manifest limit: ${name}`)
        if (!isUtf8(result.bytes) || result.bytes.includes(0)) throw new Error(`Invalid UTF-8 base file: ${name}`)
        return {
          sha256: createHash("sha256").update(result.bytes).digest("hex"),
          size: result.bytes.length,
          type: "file" as const,
          mode: match[1] as "100644" | "100755",
        }
      })()
      const target = path.join(dir, name)
      const final = await (async () => {
        if (file.status === "D") return null
        const before = await lstat(target)
        if (!before.isFile()) throw new Error(`Unsupported final file type: ${name}`)
        const actual = await realpath(target)
        inside(dir, path.relative(dir, actual))
        if (before.size > limit) throw new Error(`Final file exceeds manifest limit: ${name}`)
        const bytes = Buffer.from(await Bun.file(target).arrayBuffer())
        const after = await lstat(target)
        if (
          !after.isFile() ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ino !== after.ino ||
          before.mode !== after.mode ||
          bytes.length !== after.size
        )
          throw new Error(`Edit source changed while collecting: ${name}`)
        if (bytes.length > limit) throw new Error(`Final file exceeds manifest limit: ${name}`)
        if (!isUtf8(bytes) || bytes.includes(0)) throw new Error(`Invalid UTF-8 final file: ${name}`)
        return {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
          type: "file" as const,
          mode: (after.mode & 0o111 ? "100755" : "100644") as "100644" | "100755",
        }
      })()
      if (!base && !final) throw new Error(`Edit path has no content: ${name}`)
      files.push({ path: name, base, final })
    }
    const second = await preview({
      directory: dir,
      baseCommit: first.baseCommit,
      maxFiles: 1000,
      maxBytes: 1024 * 1024,
    })
    if (second.digest !== first.digest || second.files.length !== files.length)
      throw new Error("Edit source changed while collecting")
    return {
      directory: dir,
      baseCommit: first.baseCommit,
      previewDigest: first.digest,
      digest: createHash("sha256")
        .update(JSON.stringify({ baseCommit: first.baseCommit, files }))
        .digest("hex"),
      files,
    }
  }
}
