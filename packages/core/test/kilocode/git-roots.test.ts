import { expect, test } from "bun:test"
import { link, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { discoverGit, discoverStore } from "../../src/kilocode/git-roots"
import { prepare } from "../../src/kilocode/source-profile"
import { covers } from "../../src/kilocode/source-policy"

async function refusal(promise: Promise<unknown>, message: string) {
  const err = await promise.then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(err).toBeInstanceOf(Error)
  if (!(err instanceof Error)) throw new Error("Expected actual planner refusal")
  expect(err.message).toContain(message)
}

async function git(cwd: string, ...args: string[]) {
  const config = path.join(cwd, "fixture-config")
  await writeFile(config, "")
  const child = Bun.spawn(["git", "-c", `core.hooksPath=${path.join(cwd, "disabled-hooks")}`, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: config,
    },
  })
  const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (result[0] !== 0) throw new Error(`Fixture Git failed: ${result[2]}`)
  return result[1].trim()
}

test("pure planner covers real linked worktree admin/common metadata and cwd without writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-git-roots-"))
  const repo = path.join(root, "repo")
  const work = path.join(root, "work")
  const home = path.join(root, "home")
  await Promise.all([mkdir(repo), mkdir(home)])
  await git(repo, "init")
  await writeFile(path.join(repo, "file.txt"), "durable Git fixture")
  await git(repo, "add", "file.txt")
  await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture")
  await git(repo, "worktree", "add", "-b", "fixture", work)
  const cwd = path.join(work, "nested")
  await mkdir(cwd)
  const before = await readFile(path.join(work, ".git"))
  const value = await discoverGit(cwd)
  const common = await realpath(path.join(repo, ".git"))
  expect(value.metadata?.common).toBe(common)
  expect(value.roots).toContain(common)
  expect(value.roots).toContain(await realpath(path.join(repo, ".git/worktrees/work")))
  const planned = await prepare({ home, cwd, env: {} })
  expect(covers(planned.policy, path.join(common, "objects/new-object"))).toBe(true)
  expect(covers(planned.policy, path.join(cwd, "new-file"))).toBe(true)
  expect(covers(planned.policy, path.join(root, "unrelated/file"))).toBe(false)
  expect(await readFile(path.join(work, ".git"))).toEqual(before)
  expect(await readdir(home)).toEqual([])
  expect(Object.isFrozen(value.roots)).toBe(true)
})

test("bare store parser resolves relative alternates and canonical directory junctions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-git-stores-"))
  const repo = path.join(root, "repo")
  const other = path.join(root, "other")
  await Promise.all([mkdir(repo), mkdir(other)])
  await git(repo, "init", "--bare")
  await git(other, "init", "--bare")
  await writeFile(
    path.join(repo, "objects/info/alternates"),
    path.relative(path.join(repo, "objects"), path.join(other, "objects")) + "\n",
  )
  await writeFile(path.join(other, "objects/info/alternates"), path.join(repo, "objects") + "\n")
  const alias = path.join(root, "alias")
  await symlink(repo, alias, process.platform === "win32" ? "junction" : "dir")
  const value = await discoverStore(alias)
  expect(value.directory).toBe(await realpath(repo))
  expect(value.roots).toHaveLength(2)
  expect(value.objects).toHaveLength(2)
  expect(value.roots).toContain(await realpath(other))
  await writeFile(path.join(repo, "objects/info/alternates"), '"../other/objects"\n')
  await refusal(discoverStore(repo), "Unsupported Git alternate pointer")
})

test("metadata overrides, oversized or shared pointer files refuse before profile realization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-git-refusal-"))
  await refusal(discoverGit(root, { GIT_DIR: "external" }), "Explicit Git override")
  expect(await readdir(root)).toEqual([])
  await writeFile(path.join(root, ".git"), "gitdir: " + "x".repeat(16384))
  await refusal(discoverGit(root), "unbounded")
  await writeFile(path.join(root, ".git"), "gitdir: missing\n")
  await link(path.join(root, ".git"), path.join(root, "duplicate"))
  await refusal(discoverGit(root), "aliased")
})

test("SHA256 repository directory junction is physically pinned and unsupported storage refuses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-git-sha256-"))
  const repo = path.join(root, "repo")
  const work = path.join(root, "work")
  await Promise.all([mkdir(repo), mkdir(work)])
  await git(repo, "init", "--object-format=sha256")
  await symlink(path.join(repo, ".git"), path.join(work, ".git"), process.platform === "win32" ? "junction" : "dir")
  const value = await discoverGit(work)
  expect(value.metadata?.common).toBe(await realpath(path.join(repo, ".git")))
  expect(value.roots).toHaveLength(1)
  const config = path.join(repo, ".git/config")
  const original = await readFile(config, "utf8")
  await writeFile(config, original + "\n[extensions]\n refStorage = reftable\n")
  await refusal(discoverGit(work), "reftable/sparse")
  await writeFile(config, original + "\n[core]\n sparseCheckout = true\n")
  await refusal(discoverStore(path.join(repo, ".git")), "reftable/sparse")
})
