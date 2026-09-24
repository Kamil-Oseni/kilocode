import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ChiefEdits } from "@/kilocode/chief/edits"
import { ChiefIntegration } from "@/kilocode/chief/integration"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
}, 30_000)

function git(dir: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "raya-chief-integration-"))
  dirs.push(root)
  const parent = path.join(root, "parent")
  const child = path.join(root, "child")
  await mkdir(parent)
  git(parent, "init", "-q")
  git(parent, "config", "user.name", "Raya test")
  git(parent, "config", "user.email", "raya@example.test")
  await Bun.write(path.join(parent, "tracked.txt"), "base\n")
  git(parent, "add", ".")
  git(parent, "commit", "-qm", "base")
  const base = git(parent, "rev-parse", "HEAD")
  git(parent, "worktree", "add", "-q", "-b", "chief-edit", child, base)
  await Bun.write(path.join(child, "tracked.txt"), "edited\n")
  await Bun.write(path.join(child, "new.txt"), "added\n")
  const preview = await ChiefEdits.preview({ directory: child, baseCommit: base })
  const manifest = await ChiefEdits.manifest({ preview })
  return { parent, child, base, manifest }
}

describe("Chief integration preflight", () => {
  test("accepts exact fixed-base targets without touching the parent", async () => {
    const item = await fixture()
    const result = await ChiefIntegration.preflight({ manifest: item.manifest, parent: item.parent })
    expect(result).toMatchObject({
      baseCommit: item.base,
      digest: item.manifest.digest,
      paths: ["new.txt", "tracked.txt"],
    })
    expect(await Bun.file(path.join(item.parent, "tracked.txt")).text()).toBe("base\n")
    expect(await Bun.file(path.join(item.parent, "new.txt")).exists()).toBe(false)
    expect(git(item.parent, "status", "--porcelain")).toBe("")
  }, 30_000)

  test("rejects stale HEAD, changed targets, staged targets, and untracked collisions", async () => {
    const item = await fixture()
    await Bun.write(path.join(item.parent, "tracked.txt"), "user change\n")
    expect(ChiefIntegration.preflight({ manifest: item.manifest, parent: item.parent })).rejects.toThrow("changed")
    await Bun.write(path.join(item.parent, "tracked.txt"), "base\n")
    await Bun.write(path.join(item.parent, "new.txt"), "user file\n")
    expect(ChiefIntegration.preflight({ manifest: item.manifest, parent: item.parent })).rejects.toThrow("collides")
    await rm(path.join(item.parent, "new.txt"))
    git(item.parent, "rm", "-q", "--cached", "tracked.txt")
    expect(ChiefIntegration.preflight({ manifest: item.manifest, parent: item.parent })).rejects.toThrow("index")
    git(item.parent, "reset", "-q", "HEAD", "--", "tracked.txt")
    await Bun.write(path.join(item.parent, "other.txt"), "new commit\n")
    git(item.parent, "add", "other.txt")
    git(item.parent, "commit", "-qm", "advance")
    expect(ChiefIntegration.preflight({ manifest: item.manifest, parent: item.parent })).rejects.toThrow("HEAD changed")
  }, 30_000)

  test("rejects case aliases, manifest path overlap, and a changed digest", async () => {
    const item = await fixture()
    await Bun.write(path.join(item.parent, "NEW.txt"), "alias\n")
    expect(ChiefIntegration.preflight({ manifest: item.manifest, parent: item.parent })).rejects.toThrow(
      "Case-colliding",
    )
    await rm(path.join(item.parent, "NEW.txt"))
    const forged = {
      ...item.manifest,
      files: [...item.manifest.files, { ...item.manifest.files[0]!, path: "NEW.txt" }],
    }
    expect(ChiefIntegration.preflight({ manifest: forged, parent: item.parent })).rejects.toThrow("fingerprint")
    const duplicate = {
      ...forged,
      digest: createHash("sha256")
        .update(JSON.stringify({ baseCommit: forged.baseCommit, files: forged.files }))
        .digest("hex"),
    }
    expect(ChiefIntegration.preflight({ manifest: duplicate, parent: item.parent })).rejects.toThrow(
      "Case-colliding integration path",
    )
  }, 30_000)

  test("rejects a symlink or junction ancestor of a new path", async () => {
    const item = await fixture()
    await mkdir(path.join(item.child, "nested"))
    await Bun.write(path.join(item.child, "nested", "extra.txt"), "new\n")
    const preview = await ChiefEdits.preview({ directory: item.child, baseCommit: item.base })
    expect(preview.files.map((file) => file.path)).toContain("nested/extra.txt")
    const manifest = await ChiefEdits.manifest({ preview })
    await mkdir(path.join(path.dirname(item.parent), "elsewhere"))
    await symlink(
      path.join(path.dirname(item.parent), "elsewhere"),
      path.join(item.parent, "nested"),
      process.platform === "win32" ? "junction" : "dir",
    )
    expect(ChiefIntegration.preflight({ manifest, parent: item.parent })).rejects.toThrow("Symlink or junction")
  }, 30_000)
})
