import assert from "node:assert/strict"
import z from "zod"
import { afterEach, expect, test, spyOn } from "bun:test"
import * as child from "node:child_process"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { candidate } from "@/kilocode/git-candidate"

import { ChiefEdits } from "@/kilocode/chief/edits"
import { getGitContext } from "@/kilocode/commit-message/git-context"
const dirs: string[] = []
const env = { ...process.env }
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
  for (const dir of dirs.splice(0)) {
    expect(path.dirname(dir)).toBe(path.normalize(tmpdir()))
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)
async function fresh() {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-git-candidate-"))
  dirs.push(dir)
  return dir
}
function git(dir: string, ...args: string[]) {
  const result = child.spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 15000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
async function repo() {
  const dir = await fresh()
  git(dir, "init", "-q")
  git(dir, "config", "user.name", "Raya fixture")
  git(dir, "config", "user.email", "fixture@example.invalid")
  await Bun.write(path.join(dir, "tracked.txt"), "base\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "base")
  return { dir, base: git(dir, "rev-parse", "HEAD") }
}
async function recorded(body: (counts: { node: number; bun: number }) => Promise<void>) {
  const counts = { node: 0, bun: 0 }
  const node = child.spawnSync
  const bun = Bun.spawnSync
  // Delegates all calls to the real implementation; no canned output/error.
  const first = spyOn(child, "spawnSync").mockImplementation(
    new Proxy(node, {
      apply(target, receiver, args) {
        ++counts.node
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  const second = spyOn(Bun, "spawnSync").mockImplementation(
    new Proxy(bun, {
      apply(target, receiver, args) {
        ++counts.bun
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  try {
    await body(counts)
  } finally {
    first.mockRestore()
    second.mockRestore()
  }
}
test("plain nonrepo preserves refusal/fallback without spawning Git", async () => {
  const dir = await fresh()
  for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith("GIT_")) delete process.env[key]
  await recorded(async (counts) => {
    await assert.rejects(ChiefEdits.preview({ directory: dir, baseCommit: "0".repeat(40) }), /Git inspection failed:/)
    expect(await getGitContext(dir)).toEqual({ branch: "HEAD", recentCommits: [], files: [] })
    expect(counts.node).toBe(0)
    expect(counts.bun).toBe(0)
  })
}, 30000)
test("real committed repo preserves actual preview and context", async () => {
  const item = await repo()
  await Bun.write(path.join(item.dir, "tracked.txt"), "changed\n")
  await recorded(async (counts) => {
    const preview = await ChiefEdits.preview({ directory: item.dir, baseCommit: item.base })
    expect(preview.files.map((file) => file.path)).toEqual(["tracked.txt"])
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/)
    expect((await getGitContext(item.dir)).files.map((file) => file.path)).toEqual(["tracked.txt"])
    expect(counts.node).toBeGreaterThan(0)
    expect(counts.bun).toBeGreaterThan(0)
  })
}, 30000)
test("linked worktree gitfile and nested directories preserve Git paths", async () => {
  const item = await repo()
  const dir = await fresh()
  const linked = path.join(dir, "linked")
  git(item.dir, "worktree", "add", "--detach", linked, item.base)
  try {
    expect(await candidate(linked)).toBe(true)
    await Bun.write(path.join(linked, "tracked.txt"), "linked\n")
    expect((await ChiefEdits.preview({ directory: linked, baseCommit: item.base })).files.length).toBe(1)
    expect((await getGitContext(linked)).files.length).toBe(1)
    const nested = path.join(linked, "nested")
    await mkdir(nested)
    expect(await candidate(nested)).toBe(true)
    await assert.rejects(
      ChiefEdits.preview({ directory: nested, baseCommit: item.base }),
      /Edit preview requires the worktree root/,
    )
    expect((await getGitContext(nested)).files.length).toBe(1)
  } finally {
    git(item.dir, "worktree", "remove", "--force", linked)
  }
}, 30000)
test("actual bare repository is never classified as a plain nonrepo", async () => {
  const dir = await fresh()
  git(dir, "init", "--bare", "-q")
  expect(await candidate(dir)).toBe(true)
  await recorded(async (counts) => {
    await assert.rejects(ChiefEdits.preview({ directory: dir, baseCommit: "0".repeat(40) }), /Git inspection failed:/)
    await getGitContext(dir)
    expect(counts.node).toBeGreaterThan(0)
    expect(counts.bun).toBeGreaterThan(0)
  })
}, 30000)
function context(dir: string) {
  const module = path.resolve(import.meta.dir, "../../src/kilocode/commit-message/git-context.ts")
  const code = `const {getGitContext}=await import(${JSON.stringify(module)}); console.log(JSON.stringify(await getGitContext(${JSON.stringify(dir)})))`
  const result = child.spawnSync(process.execPath, ["--eval", code], {
    cwd: dir,
    env: { ...process.env },
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1048576,
  })
  if (result.error) throw result.error
  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  return z.object({ recentCommits: z.array(z.string()) }).parse(JSON.parse(result.stdout))
}
test("explicit Git directory/worktree context reaches genuine Git", async () => {
  const item = await repo()
  const outside = await fresh()
  process.env.GIT_DIR = path.join(item.dir, ".git")
  process.env.GIT_WORK_TREE = item.dir
  expect(await candidate(outside)).toBe(true)
  // A fresh original Bun child receives overrides at startup; no cached ambient env assumption.
  expect(context(outside).recentCommits.length).toBe(1)
  await recorded(async (counts) => {
    await getGitContext(outside)
    expect(counts.bun).toBeGreaterThan(0)
  })
}, 30000)
test("other Git overrides defer validation rather than invent nonrepo", async () => {
  const dir = await fresh()
  process.env.GIT_CONFIG_GLOBAL = path.join(dir, "absent-config")
  expect(await candidate(dir)).toBe(true)
  await recorded(async (counts) => {
    await assert.rejects(ChiefEdits.preview({ directory: dir, baseCommit: "0".repeat(40) }), /Git inspection failed:/)
    expect(counts.node).toBeGreaterThan(0)
  })
}, 30000)
test("corrupt gitfile retains real Git error, missing cwd remains candidate", async () => {
  const dir = await fresh()
  await Bun.write(path.join(dir, ".git"), "not a gitdir pointer\n")
  expect(await candidate(dir)).toBe(true)
  expect(await candidate(path.join(dir, "absent"))).toBe(true)
  await recorded(async (counts) => {
    await assert.rejects(ChiefEdits.preview({ directory: dir, baseCommit: "0".repeat(40) }), /Git inspection failed:/)
    expect(counts.node).toBeGreaterThan(0)
  })
}, 30000)

test("lowercase Windows Git overrides preserve genuine explicit context", async () => {
  const item = await repo()
  const outside = await fresh()
  process.env.git_dir = path.join(item.dir, ".git")
  process.env.git_work_tree = item.dir
  expect(await candidate(outside)).toBe(true)
  if (process.platform === "win32") expect(context(outside).recentCommits.length).toBe(1)
  await recorded(async (counts) => {
    await getGitContext(outside)
    expect(counts.bun).toBeGreaterThan(0)
  })
}, 30000)
