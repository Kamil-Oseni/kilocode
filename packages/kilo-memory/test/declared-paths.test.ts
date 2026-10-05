import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryPaths } from "../src/storage/paths"

test("pure canonical memory folders preserve ordinary plain and linked repository identities", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-memory-paths-")))
  const plain = path.join(root, "plain café 日本語"),
    repo = path.join(root, "repo"),
    linked = path.join(root, "linked")
  await mkdir(plain)
  await mkdir(path.join(repo, ".git", "worktrees", "linked"), { recursive: true })
  await mkdir(linked)
  await writeFile(path.join(linked, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "linked")}\n`)
  await writeFile(path.join(repo, ".git", "worktrees", "linked", "gitdir"), path.join(linked, ".git"))
  await writeFile(path.join(repo, ".git", "worktrees", "linked", "commondir"), "../..\n")
  for (const directory of [plain, repo, linked, path.join(repo, ".", "..", "repo")]) {
    const id = MemoryPaths.identity({ ctx: { directory, worktree: directory } })
    expect(MemoryPaths.declared(id.canonical)).toEqual(id)
  }
  expect(MemoryPaths.identity({ ctx: { directory: linked, worktree: linked } })).toEqual(
    MemoryPaths.identity({ ctx: { directory: repo, worktree: repo } }),
  )
  expect(MemoryPaths.identity({ ctx: { directory: plain, worktree: "/" } })).toEqual(MemoryPaths.declared(plain))
  expect(() => MemoryPaths.declared("relative")).toThrow()
})
