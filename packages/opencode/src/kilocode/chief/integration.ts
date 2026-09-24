import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import type { ChiefEdits } from "./edits"

/** Read-only admission check. The caller must repeat it under an integration lock before dispatch. */
export namespace ChiefIntegration {
  function git(dir: string, args: string[]) {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "buffer",
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    })
    if (result.error || result.status !== 0)
      throw new Error(`Git preflight failed: ${result.error?.message ?? result.stderr.toString("utf8").trim()}`)
    return result.stdout
  }

  function listing(bytes: Buffer) {
    if (bytes.length && bytes.at(-1) !== 0) throw new Error("Incomplete Git path listing")
    return bytes.toString("utf8").split("\0").filter(Boolean)
  }

  function entry(bytes: Buffer, name: string, index: boolean) {
    const rows = listing(bytes)
    if (rows.length > 1) throw new Error(`Ambiguous Git path: ${name}`)
    if (!rows.length) return null
    const match = rows[0]!.match(
      index ? /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/ : /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/,
    )
    if (!match || match[4] !== name || (index && match[3] !== "0")) throw new Error(`Invalid Git path entry: ${name}`)
    return { mode: match[1]!, hash: index ? match[2]! : match[3]!, type: index ? "blob" : match[2]! }
  }

  function valid(name: string) {
    if (
      !name ||
      name.includes("\\") ||
      name.includes("\0") ||
      path.posix.isAbsolute(name) ||
      name.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":") || /[. ]$/.test(part))
    )
      throw new Error(`Unsafe integration path: ${name}`)
    return name.split("/")
  }

  async function stat(file: string) {
    return lstat(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined
      throw err
    })
  }

  /** Proves the parent still contains the fixed base at every touched path. No files are changed. */
  export async function preflight(input: { manifest: ChiefEdits.Manifest; parent: string }) {
    const manifest = input.manifest
    if (!/^[0-9a-f]{40,64}$/i.test(manifest.baseCommit) || !/^[0-9a-f]{64}$/i.test(manifest.digest))
      throw new Error("Invalid edit manifest identity")
    const digest = createHash("sha256")
      .update(JSON.stringify({ baseCommit: manifest.baseCommit, files: manifest.files }))
      .digest("hex")
    if (digest !== manifest.digest) throw new Error("Edit manifest fingerprint changed")
    const dir = await realpath(input.parent)
    const root = git(dir, ["rev-parse", "--show-toplevel"]).toString("utf8").trim()
    if (path.normalize(await realpath(root)).toLowerCase() !== path.normalize(dir).toLowerCase())
      throw new Error("Integration target must be the parent checkout root")
    const head = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim()
    if (head.toLowerCase() !== manifest.baseCommit.toLowerCase())
      throw new Error("Parent HEAD changed after the edit worktree was created")
    const seen = new Set<string>()
    const folders = new Map<string, string>()
    for (const file of manifest.files) {
      const parts = valid(file.path)
      const key = file.path.toLowerCase()
      for (const [index] of parts.entries()) {
        const prefix = parts.slice(0, index + 1).join("/")
        const old = folders.get(prefix.toLowerCase())
        if (old && old !== prefix) throw new Error(`Case-colliding integration path: ${file.path}`)
        folders.set(prefix.toLowerCase(), prefix)
      }
      if (
        seen.has(key) ||
        parts.slice(0, -1).some((_, index) =>
          seen.has(
            parts
              .slice(0, index + 1)
              .join("/")
              .toLowerCase(),
          ),
        )
      )
        throw new Error(`Overlapping integration path: ${file.path}`)
      seen.add(key)
    }
    for (const file of manifest.files) {
      const parts = valid(file.path)
      if (
        manifest.files.some(
          (other) => other.path !== file.path && other.path.toLowerCase().startsWith(`${file.path.toLowerCase()}/`),
        )
      )
        throw new Error(`Overlapping integration path: ${file.path}`)
      const tree = entry(git(dir, ["ls-tree", "-z", manifest.baseCommit, "--", file.path]), file.path, false)
      const staged = entry(git(dir, ["ls-files", "--stage", "-z", "--", file.path]), file.path, true)
      if (!file.base) {
        if (tree || staged) throw new Error(`New integration path already exists in Git: ${file.path}`)
      } else {
        if (!tree || tree.type !== "blob" || tree.mode !== file.base.mode)
          throw new Error(`Base Git entry differs from edit manifest: ${file.path}`)
        const blob = git(dir, ["cat-file", "blob", tree.hash])
        if (blob.length !== file.base.size || createHash("sha256").update(blob).digest("hex") !== file.base.sha256)
          throw new Error(`Base bytes differ from edit manifest: ${file.path}`)
        if (!staged || staged.mode !== tree.mode || staged.hash !== tree.hash)
          throw new Error(`Parent index changed at integration path: ${file.path}`)
      }
      let current = dir
      let missing = false
      for (const [index, part] of parts.entries()) {
        if (missing) break
        const names = await readdir(current)
        const aliases = names.filter((name) => name.toLowerCase() === part.toLowerCase())
        if (aliases.length > 1 || (aliases.length === 1 && aliases[0] !== part))
          throw new Error(`Case-colliding parent path: ${file.path}`)
        current = path.join(current, part)
        const info = await stat(current)
        if (!info) {
          if (file.base) throw new Error(`Parent path disappeared: ${file.path}`)
          missing = true
          break
        }
        if (info.isSymbolicLink()) throw new Error(`Symlink or junction in parent path: ${file.path}`)
        if (index < parts.length - 1) {
          if (!info.isDirectory()) throw new Error(`Non-directory ancestor in parent path: ${file.path}`)
          if (path.normalize(await realpath(current)).toLowerCase() !== path.normalize(current).toLowerCase())
            throw new Error(`Reparsed ancestor in parent path: ${file.path}`)
          continue
        }
        if (!file.base) throw new Error(`New integration path collides with parent file: ${file.path}`)
        if (!info.isFile() || info.size !== file.base.size)
          throw new Error(`Parent target changed since fixed base: ${file.path}`)
        if (process.platform !== "win32" && (info.mode & 0o111 ? "100755" : "100644") !== file.base.mode)
          throw new Error(`Parent target mode changed since fixed base: ${file.path}`)
        const bytes = await readFile(current)
        const after = await lstat(current)
        if (
          !after.isFile() ||
          info.ino !== after.ino ||
          info.mtimeMs !== after.mtimeMs ||
          bytes.length !== file.base.size ||
          createHash("sha256").update(bytes).digest("hex") !== file.base.sha256
        )
          throw new Error(`Parent target changed since fixed base: ${file.path}`)
      }
      if (file.base && missing) throw new Error(`Parent target disappeared: ${file.path}`)
    }
    return { parent: dir, baseCommit: head, digest: manifest.digest, paths: manifest.files.map((file) => file.path) }
  }
}
