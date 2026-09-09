import { expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { capture, materialize, unchanged } from "@/kilocode/self-heal/snapshot"
import { checkout, git, lfs } from "./fixtures/self-heal-worktree"

async function fixture(run: (root: string, source: Awaited<ReturnType<typeof checkout>>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-snapshot-test-"))
  try {
    await run(root, await checkout(path.join(root, "storage")))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test(
  "captures dirty/untracked bytes and deletions, excludes ignored dependencies and credentials, and materializes private files",
  () =>
    fixture(async (root, source) => {
      await fs.writeFile(path.join(source.root, ".gitignore"), "node_modules/\n.env\n")
      await fs.writeFile(path.join(source.root, "tracked.txt"), "repaired bytes")
      await fs.writeFile(path.join(source.root, "new.txt"), "new input")
      await fs.writeFile(path.join(source.root, ".env"), "PRIVATE=do-not-copy")
      await fs.mkdir(path.join(source.root, "node_modules"))
      await fs.writeFile(path.join(source.root, "node_modules", "private"), "dependency")
      await fs.rm(path.join(source.root, "packages", "kilo-vscode", "package.json"))
      const store = path.join(root, "store")
      const snapshot = await capture(source.root, store)
      expect(snapshot.files.map((row) => row.path)).toContain("new.txt")
      expect(snapshot.files.map((row) => row.path)).not.toContain(".env")
      expect(snapshot.files.map((row) => row.path)).not.toContain("node_modules/private")
      expect(snapshot.files.map((row) => row.path)).not.toContain("packages/kilo-vscode/package.json")
      const directory = await materialize(store, snapshot)
      expect(await fs.readFile(path.join(directory, "tracked.txt"), "utf8")).toBe("repaired bytes")
      await fs.writeFile(path.join(source.root, "tracked.txt"), "later edit")
      expect(await fs.readFile(path.join(directory, "tracked.txt"), "utf8")).toBe("repaired bytes")
      expect((await capture(source.root)).digest).not.toBe(snapshot.digest)
      await unchanged(directory, snapshot)
      await fs.writeFile(path.join(directory, "extra.ts"), "new source")
      await expect(unchanged(directory, snapshot)).rejects.toThrow("additional nonignored")
    }),
  30_000,
)

test(
  "rejects modified snapshot input and corrupted retained blobs",
  () =>
    fixture(async (root, source) => {
      const store = path.join(root, "store")
      const snapshot = await capture(source.root, store)
      const directory = await materialize(store, snapshot)
      await fs.writeFile(path.join(directory, "tracked.txt"), "mutated check input")
      await expect(unchanged(directory, snapshot)).rejects.toThrow("changed")
      await fs.writeFile(path.join(store, "blobs", snapshot.files[0].digest), "corrupt")
      await expect(materialize(store, snapshot)).rejects.toThrow("does not match")
    }),
  30_000,
)

test(
  "uses materialized LFS bytes without invoking configured filters and rejects unresolved pointers",
  () =>
    fixture(async (root, source) => {
      const data = await lfs(source, "source")
      const store = path.join(root, "store")
      const snapshot = await capture(source.root, store)
      const directory = await materialize(store, snapshot)
      expect(await fs.readFile(path.join(directory, "asset.bin"))).toEqual(data)
      expect(await fs.readdir(source.root)).not.toContain(".filter-ran")
      await fs.writeFile(path.join(source.root, "asset.bin"), await git(source.root, ["show", "HEAD:asset.bin"]))
      await expect(capture(source.root)).rejects.toThrow("LFS pointer")
    }),
  30_000,
)

test(
  "rejects credential-shaped unignored inputs and mismatched Git ownership",
  () =>
    fixture(async (_root, source) => {
      await fs.writeFile(path.join(source.root, ".npmrc"), "secret=fixture")
      await expect(capture(source.root)).rejects.toThrow("credential-bearing")
      await fs.rm(path.join(source.root, ".npmrc"))
      await expect(capture(source.root, undefined, { common: "/unrelated", commit: source.commit })).rejects.toThrow(
        "ownership",
      )
    }),
  30_000,
)

test(
  "retains ordinary npm configuration and Git executable mode without copying auth configuration",
  () =>
    fixture(async (root, source) => {
      await fs.writeFile(
        path.join(source.root, ".npmrc"),
        "enable-pre-post-scripts = true\nregistry=https://registry.npmjs.org/\n",
      )
      await git(source.root, ["update-index", "--chmod=+x", "tracked.txt"])
      const snapshot = await capture(source.root, path.join(root, "store"))
      expect(snapshot.files.map((row) => row.path)).toContain(".npmrc")
      if (process.platform === "win32") expect(snapshot.files.find((row) => row.path === "tracked.txt")?.mode).toBe(493)
      const directory = await materialize(path.join(root, "store"), snapshot)
      await unchanged(directory, snapshot)
      await fs.writeFile(path.join(source.root, ".npmrc"), "//registry.npmjs.org/:_authToken=fixture\n")
      await expect(capture(source.root)).rejects.toThrow("credential-bearing")
    }),
  30_000,
)

test(
  "source capture detects a concurrently changing working file",
  () =>
    fixture(async (_root, source) => {
      const file = path.join(source.root, "tracked.txt")
      let pending = true
      const writing = (async () => {
        while (pending) await fs.appendFile(file, "x")
      })()
      try {
        await expect(capture(source.root)).rejects.toThrow("changed")
      } finally {
        pending = false
        await writing
      }
    }),
  30_000,
)

test(
  "rejects redirected source/storage directories without copying through them",
  () =>
    fixture(async (root, source) => {
      const outside = path.join(root, "outside")
      await fs.mkdir(outside)
      await fs.writeFile(path.join(outside, "foreign.txt"), "foreign input")
      await fs.symlink(outside, path.join(source.root, "linked"), "junction")
      await expect(capture(source.root)).rejects.toThrow()
      const clean = await checkout(path.join(root, "second", "storage"))
      const store = path.join(root, "store")
      await fs.mkdir(store)
      await fs.symlink(outside, path.join(store, "blobs"), "junction")
      await expect(capture(clean.root, store)).rejects.toThrow("redirected")
      expect(await fs.readdir(outside)).toEqual(["foreign.txt"])
    }),
  30_000,
)
