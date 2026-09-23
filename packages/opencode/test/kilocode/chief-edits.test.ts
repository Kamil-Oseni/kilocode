import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
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
    const preview = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base, maxBytes: 1024 })
    expect(preview.truncated).toBe(true)
    expect(preview.digest).toBeUndefined()
    expect(preview.files[0]).toMatchObject({ path: "large.txt", truncated: true, patch: undefined })
    expect(preview.files[1]?.patch).toBeUndefined()
    const binary = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base, maxFiles: 2 })
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

  test("rejects wrong roots and fixed base identities", async () => {
    const item = await repo()
    expect(ChiefEdits.preview({ directory: path.dirname(item.dir), baseCommit: item.base })).rejects.toThrow()
    expect(ChiefEdits.preview({ directory: item.dir, baseCommit: "f".repeat(40) })).rejects.toThrow()
    await Bun.write(path.join(item.dir, "café name.txt"), "inside\n")
    const preview = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base })
    expect(preview.files[0]).toMatchObject({ path: "café name.txt", patch: "inside\n" })
  }, 30_000)
})
