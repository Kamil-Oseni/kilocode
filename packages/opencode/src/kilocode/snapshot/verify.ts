import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"

type Patch = { hash: string; files: readonly string[] }
type Git = (args: string[], stdin?: string) => Effect.Effect<{ code: number; text: string }>

export class WorkspaceConflict extends Error {
  constructor() {
    super("Workspace files changed before the restore could be applied")
    this.name = "WorkspaceConflict"
  }
}

const missing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

async function parent(file: string, worktree: string, root: string) {
  let directory = path.dirname(file)
  while (true) {
    const resolved = await fs.realpath(directory).catch((error: unknown) => {
      if (missing(error)) return undefined
      throw error
    })
    if (resolved) return path.relative(path.resolve(root, path.relative(worktree, directory)), resolved) === ""
    if (directory === worktree || directory === path.dirname(directory)) return false
    directory = path.dirname(directory)
  }
}

/** Compare live files with immutable Git blobs without trusting the mutable snapshot index. */
export const matches = Effect.fn("SnapshotReview.matches")(function* (
  git: Git,
  worktree: string,
  patches: readonly Patch[],
) {
  const root = yield* Effect.tryPromise(() => fs.realpath(worktree)).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!root) return false
  const jobs = patches.flatMap((patch) =>
    patch.files.map((file) => ({ hash: patch.hash, file: path.resolve(worktree, file) })),
  )
  const results = yield* Effect.forEach(
    jobs,
    (job) =>
      Effect.gen(function* () {
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(job.hash)) return false
        const relative = path.relative(worktree, job.file).replaceAll("\\", "/")
        if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return false
        if (!(yield* Effect.tryPromise(() => parent(job.file, worktree, root)))) return false
        const tree = yield* git(["--literal-pathspecs", "ls-tree", "-z", job.hash, "--", relative])
        if (tree.code !== 0) return false
        const rows = tree.text.split("\0").filter(Boolean)
        const stat = yield* Effect.tryPromise(() =>
          fs.lstat(job.file).catch((error: unknown) => {
            if (missing(error)) return undefined
            throw error
          }),
        )
        if (!rows.length) return stat === undefined
        if (!stat || rows.length !== 1) return false
        const row = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(rows[0])
        if (!row || row[3] !== relative) return false
        const link = row[1] === "120000"
        if (link !== stat.isSymbolicLink() || (!link && !stat.isFile())) return false
        if (!link && process.platform !== "win32" && (row[1] === "100755") !== !!(stat.mode & 0o111)) return false
        const content = link ? yield* Effect.tryPromise(() => fs.readlink(job.file)) : undefined
        const hash = yield* git(
          link ? ["hash-object", "--no-filters", "--stdin"] : ["hash-object", `--path=${relative}`, "--", job.file],
          content,
        )
        if (hash.code !== 0 || hash.text.trim() !== row[2]) return false
        const after = yield* Effect.tryPromise(() => fs.lstat(job.file))
        if (
          stat.dev !== after.dev ||
          stat.ino !== after.ino ||
          stat.size !== after.size ||
          stat.mtimeMs !== after.mtimeMs ||
          stat.ctimeMs !== after.ctimeMs ||
          stat.mode !== after.mode
        )
          return false
        return yield* Effect.tryPromise(() => parent(job.file, worktree, root))
      }).pipe(Effect.catchCause(() => Effect.succeed(false))),
    { concurrency: 8 },
  )
  return results.every(Boolean)
})
