import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { capture, materialize, unchanged, type Snapshot } from "@/kilocode/self-heal/snapshot"
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
  "refuses damaged retained content during recapture and before materialization",
  () =>
    fixture(async (root, source) => {
      const store = path.join(root, "store")
      const snapshot = await capture(source.root, store)
      const file = snapshot.files[0]
      const blob = path.join(store, "blobs", file.digest)
      const original = await fs.readFile(blob)
      await fs.writeFile(blob, "corrupt")
      await expect(capture(source.root, store)).rejects.toThrow("corrupt")
      await expect(materialize(store, snapshot)).rejects.toThrow("does not match")
      await fs.unlink(blob)
      await expect(materialize(store, snapshot)).rejects.toThrow("ENOENT")
      await fs.writeFile(blob, original, { flag: "wx" })
      const retained = path.join(store, "blobs")
      const moved = path.join(store, "retained")
      expect(await fs.realpath(retained)).toBe(retained)
      expect(path.dirname(moved)).toBe(store)
      await fs.rename(retained, moved)
      await fs.symlink(moved, retained, "junction")
      try {
        await expect(materialize(store, snapshot)).rejects.toThrow("redirected")
      } finally {
        expect((await fs.lstat(retained)).isSymbolicLink()).toBe(true)
        if (process.platform === "win32") await fs.rmdir(retained)
        if (process.platform !== "win32") await fs.unlink(retained)
      }
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

function manifest(snapshot: Snapshot, files: Snapshot["files"]): Snapshot {
  const data = { head: snapshot.head, files }
  return { version: 1, digest: createHash("sha256").update(JSON.stringify(data)).digest("hex"), ...data }
}

async function observed(directory: string) {
  const names = (await fs.readdir(directory, { recursive: true })).sort()
  return Promise.all(
    names.map(async (name) => {
      const file = path.join(directory, name)
      const stat = await fs.lstat(file)
      return {
        name,
        size: stat.size,
        modified: stat.mtimeMs,
        digest: stat.isFile()
          ? createHash("sha256")
              .update(await fs.readFile(file))
              .digest("hex")
          : undefined,
      }
    }),
  )
}

function rejected(value: Promise<unknown>) {
  return value.then(
    () => {
      throw new Error("Expected operation to reject")
    },
    (error: unknown) => error,
  )
}

async function quiescent(store: string) {
  const runs = path.join(store, "runs")
  const names = await fs.readdir(runs)
  expect(names).toHaveLength(1)
  const directory = path.join(runs, names[0])
  expect(await rejected(fs.lstat(path.join(directory, ".git")))).toMatchObject({ code: "ENOENT" })
  expect(await rejected(fs.lstat(path.join(directory, "later", "not-started.txt")))).toMatchObject({ code: "ENOENT" })
  const before = await observed(directory)
  // Observe real filesystem writes after rejection; this complements the worker-drain control-flow check.
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(await observed(directory)).toEqual(before)
}

test(
  "materializes multiple batches with shared directories, reused blobs and a file larger than the batch byte budget",
  () =>
    fixture(async (root, source) => {
      const directory = path.join(source.root, "shared", "nested")
      await fs.mkdir(directory, { recursive: true })
      for (let index = 0; index < 36; index++) {
        const folder = path.join(directory, String(index % 3))
        await fs.mkdir(folder, { recursive: true })
        await fs.writeFile(path.join(folder, `${index}.txt`), index % 2 ? `unique ${index}` : "reused bytes")
      }
      await fs.writeFile(path.join(source.root, "large.bin"), Buffer.alloc(33 * 1024 * 1024, 0x64))
      const store = path.join(root, "store")
      const snapshot = await capture(source.root, store)
      const result = await materialize(store, snapshot)
      expect(snapshot.files.length).toBeGreaterThan(36)
      for (const file of snapshot.files) {
        const output = path.join(result, file.path)
        const data = await fs.readFile(output)
        expect(data.length).toBe(file.size)
        expect(createHash("sha256").update(data).digest("hex")).toBe(file.digest)
        expect((await fs.lstat(output)).isFile()).toBe(true)
        expect(await fs.realpath(output)).toBe(output)
      }
      await unchanged(result, snapshot)
      await fs.writeFile(path.join(result, "shared", "nested", "0", "0.txt"), "private edit")
      expect(await fs.readFile(path.join(result, "shared", "nested", "2", "2.txt"), "utf8")).toBe("reused bytes")
      expect(await fs.readFile(path.join(directory, "0", "0.txt"), "utf8")).toBe("reused bytes")
      const original = snapshot.files.find((file) => file.path === "shared/nested/0/0.txt")
      expect(original).toBeDefined()
      expect(await fs.readFile(path.join(store, "blobs", original!.digest), "utf8")).toBe("reused bytes")
    }),
  60_000,
)

test(
  "duplicate paths and corrupt blobs reject without starting later batches or leaving writes active",
  () =>
    fixture(async (root, source) => {
      await fs.writeFile(path.join(source.root, "small.txt"), "original small bytes")
      for (let index = 0; index < 6; index++)
        await fs.writeFile(path.join(source.root, `large-${index}.bin`), Buffer.alloc(2 * 1024 * 1024, index + 1))
      const retained = path.join(root, "retained")
      const snapshot = await capture(source.root, retained)
      const small = snapshot.files.find((file) => file.path === "small.txt")
      const large = snapshot.files.filter((file) => file.path.startsWith("large-"))
      expect(small).toBeDefined()
      expect(large).toHaveLength(6)
      const later = { ...small!, path: "later/not-started.txt" }
      const duplicate = manifest(snapshot, [large[0], small!, small!, ...large.slice(1), later])
      expect(await rejected(materialize(retained, duplicate))).toMatchObject({ code: "EEXIST" })
      await quiescent(retained)

      const corrupt = path.join(root, "corrupt")
      await capture(source.root, corrupt)
      const blob = path.join(corrupt, "blobs", small!.digest)
      await fs.writeFile(blob, Buffer.alloc(small!.size, 0x78))
      const invalid = manifest(snapshot, [small!, ...large, { ...small!, path: "sibling.txt" }, later])
      expect(await rejected(materialize(corrupt, invalid))).toMatchObject({
        message: expect.stringContaining("does not match"),
      })
      await quiescent(corrupt)

      const runs = path.join(retained, "runs")
      const before = new Set(await fs.readdir(runs))
      const negative = manifest(snapshot, [{ ...small!, size: -1 }, ...large, later])
      expect(await rejected(materialize(retained, negative))).toBeInstanceOf(Error)
      const added = (await fs.readdir(runs)).filter((name) => !before.has(name))
      expect(added.length).toBeLessThanOrEqual(1)
      for (const name of added) expect(await fs.readdir(path.join(runs, name))).toEqual([])
    }),
  60_000,
)
