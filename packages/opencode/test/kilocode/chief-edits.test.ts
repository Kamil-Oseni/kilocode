import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ChiefEdits } from "@/kilocode/chief/edits"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
}, 30_000)

function git(dir: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function repo() {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-chief-edits-"))
  dirs.push(dir)
  git(dir, "init", "-q")
  git(dir, "config", "user.name", "Raya test")
  git(dir, "config", "user.email", "raya@example.test")
  await Bun.write(path.join(dir, "tracked.txt"), "base\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "base")
  return { dir, base: git(dir, "rev-parse", "HEAD") }
}

describe("Chief edit preview", () => {
  test("builds a byte-exact manifest for changed, added, and deleted regular files", async () => {
    const item = await repo()
    await Bun.write(path.join(item.dir, "delete.txt"), "remove me\n")
    git(item.dir, "add", "delete.txt")
    git(item.dir, "commit", "-qm", "add deletion fixture")
    const base = git(item.dir, "rev-parse", "HEAD")
    await Bun.write(path.join(item.dir, "tracked.txt"), "updated\n")
    await rm(path.join(item.dir, "delete.txt"))
    await Bun.write(path.join(item.dir, "new.txt"), "added\n")
    const first = await ChiefEdits.preview({ directory: item.dir, baseCommit: base })
    const manifest = await ChiefEdits.manifest({ preview: first })
    expect(manifest.previewDigest).toBe(first.digest!)
    expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.files.map((file) => file.path)).toEqual(["delete.txt", "new.txt", "tracked.txt"])
    expect(manifest.files[0]).toMatchObject({
      base: { sha256: createHash("sha256").update("remove me\n").digest("hex"), type: "file", mode: "100644" },
      final: null,
    })
    expect(manifest.files[1]).toMatchObject({
      base: null,
      final: { sha256: createHash("sha256").update("added\n").digest("hex"), type: "file", mode: "100644" },
    })
    expect(manifest.files[2]).toMatchObject({
      base: { sha256: createHash("sha256").update("base\n").digest("hex") },
      final: { sha256: createHash("sha256").update("updated\n").digest("hex") },
    })
    expect((await ChiefEdits.manifest({ preview: first })).digest).toBe(manifest.digest)
  }, 30_000)

  test("refuses stale, truncated, binary, and invalid UTF-8 previews", async () => {
    const item = await repo()
    await Bun.write(path.join(item.dir, "new.txt"), "ready\n")
    const first = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base })
    await Bun.write(path.join(item.dir, "new.txt"), "changed\n")
    expect(ChiefEdits.manifest({ preview: first })).rejects.toThrow("changed")
    await Bun.write(path.join(item.dir, "new.txt"), "a".repeat(3000))
    const truncated = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base, maxBytes: 1024 })
    expect(ChiefEdits.manifest({ preview: truncated })).rejects.toThrow("incomplete")
    await Bun.write(path.join(item.dir, "new.txt"), new Uint8Array([0xff, 0x00]))
    const binary = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base })
    expect(ChiefEdits.manifest({ preview: binary })).rejects.toThrow("incomplete")
    await Bun.write(path.join(item.dir, "new.txt"), new Uint8Array([0xc3, 0x28]))
    const invalid = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base })
    expect(ChiefEdits.manifest({ preview: invalid })).rejects.toThrow("incomplete")
  }, 30_000)

  test("refuses a symlink in the fixed base tree", async () => {
    const item = await repo()
    await Bun.write(path.join(item.dir, "link-content.txt"), "tracked.txt")
    const blob = git(item.dir, "hash-object", "-w", "link-content.txt")
    git(item.dir, "update-index", "--add", "--cacheinfo", `120000,${blob},link.txt`)
    git(item.dir, "commit", "-qm", "link in base")
    const base = git(item.dir, "rev-parse", "HEAD")
    git(item.dir, "rm", "-q", "link.txt")
    const first = await ChiefEdits.preview({ directory: item.dir, baseCommit: base })
    expect(ChiefEdits.manifest({ preview: first })).rejects.toThrow("incomplete or contains unsupported content")
  }, 30_000)

  test("refuses a submodule in the fixed base tree", async () => {
    const item = await repo()
    git(item.dir, "update-index", "--add", "--cacheinfo", `160000,${item.base},module`)
    git(item.dir, "commit", "-qm", "submodule in base")
    const base = git(item.dir, "rev-parse", "HEAD")
    git(item.dir, "rm", "-q", "--cached", "module")
    const first = await ChiefEdits.preview({ directory: item.dir, baseCommit: base })
    expect(ChiefEdits.manifest({ preview: first })).rejects.toThrow("incomplete or contains unsupported content")
  }, 30_000)

  test("shows fixed-base committed, working, staged, and untracked edits in stable order", async () => {
    const item = await repo()
    await Bun.write(path.join(item.dir, "tracked.txt"), "changed\n")
    await Bun.write(path.join(item.dir, "staged.txt"), "staged\n")
    git(item.dir, "add", "staged.txt")
    git(item.dir, "commit", "-qm", "staged")
    await Bun.write(path.join(item.dir, "z.txt"), "outside Git\n")
    const preview = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base })
    expect(preview.clean).toBe(false)
    expect(preview.truncated).toBe(false)
    expect(preview.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(preview.files.map((file) => file.path)).toEqual(["staged.txt", "tracked.txt", "z.txt"])
    expect(preview.files[0]?.patch).toContain("+staged")
    expect(preview.files[1]?.patch).toContain("+changed")
    expect(preview.files[2]).toMatchObject({ untracked: true, patch: "outside Git\n" })
    expect(git(item.dir, "status", "--porcelain")).toBe("M tracked.txt\n?? z.txt")
    await Bun.write(path.join(item.dir, "z.txt"), "changed outside Git\n")
    expect((await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base })).digest).not.toBe(preview.digest)
  }, 30_000)

  test("does not turn capped or binary content into a complete text patch", async () => {
    const item = await repo()
    await Bun.write(path.join(item.dir, "large.txt"), "a".repeat(3000))
    await Bun.write(path.join(item.dir, "raw.bin"), new Uint8Array([0, 1, 2]))
    await Bun.write(path.join(item.dir, "invalid.txt"), new Uint8Array([0xc3, 0x28]))
    const preview = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base, maxBytes: 1024 })
    expect(preview.truncated).toBe(true)
    expect(preview.digest).toBeUndefined()
    expect(preview.files.find((file) => file.path === "large.txt")).toMatchObject({ truncated: true, patch: undefined })
    expect(preview.files.find((file) => file.path === "invalid.txt")).toMatchObject({ binary: true, patch: undefined })
    const binary = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base, maxFiles: 3 })
    expect(binary.files.find((file) => file.path === "raw.bin")).toMatchObject({ binary: true, patch: undefined })
    const limited = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base, maxFiles: 1 })
    expect(limited.truncated).toBe(true)
  }, 30_000)

  test("reports merge conflicts without proposing an integrable patch", async () => {
    const item = await repo()
    git(item.dir, "checkout", "-qb", "left")
    await Bun.write(path.join(item.dir, "tracked.txt"), "left\n")
    git(item.dir, "commit", "-qam", "left")
    git(item.dir, "checkout", "-q", item.base)
    git(item.dir, "checkout", "-qb", "right")
    await Bun.write(path.join(item.dir, "tracked.txt"), "right\n")
    git(item.dir, "commit", "-qam", "right")
    const merged = spawnSync("git", ["merge", "left"], { cwd: item.dir, encoding: "utf8", windowsHide: true })
    expect(merged.status).not.toBe(0)
    const preview = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base })
    expect(preview.conflicts).toEqual(["tracked.txt"])
    expect(preview.digest).toBeUndefined()
    expect(preview.files.find((file) => file.path === "tracked.txt")).toMatchObject({
      conflict: true,
      patch: undefined,
    })
  }, 30_000)

  test("withholds fingerprints for Git link modes", async () => {
    const item = await repo()
    await Bun.write(path.join(item.dir, "target.txt"), "tracked.txt")
    const blob = git(item.dir, "hash-object", "-w", "target.txt")
    git(item.dir, "update-index", "--add", "--cacheinfo", `120000,${blob},link.txt`)
    await Bun.write(path.join(item.dir, "link.txt"), "tracked.txt")
    const preview = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base })
    expect(preview.digest).toBeUndefined()
    expect(preview.files.find((file) => file.path === "link.txt")).toMatchObject({ binary: true, patch: undefined })
  }, 30_000)

  test("rejects wrong roots and fixed base identities", async () => {
    const item = await repo()
    expect(ChiefEdits.preview({ directory: path.dirname(item.dir), baseCommit: item.base })).rejects.toThrow()
    expect(ChiefEdits.preview({ directory: item.dir, baseCommit: "f".repeat(40) })).rejects.toThrow()
    await Bun.write(path.join(item.dir, "café name.txt"), "inside\n")
    const preview = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base })
    expect(preview.files[0]).toMatchObject({ path: "café name.txt", patch: "inside\n" })
  }, 30_000)
})
