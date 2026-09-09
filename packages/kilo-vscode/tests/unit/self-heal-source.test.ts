import { expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { exec } from "../../src/util/process"
import { resolve, current } from "../../src/self-heal/source"
import { capture } from "../../src/self-heal/intake"

async function git(dir: string, args: string[]) {
  return (
    await exec("git", ["-C", dir, "-c", "core.hooksPath=disabled-test-hooks", ...args], { timeout: 15_000 })
  ).stdout.trim()
}
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-self-heal-"))
  const root = path.join(dir, "source")
  const workspace = path.join(dir, "unrelated")
  const store = path.join(dir, "global", "self-heal")
  await fs.mkdir(path.join(root, "packages", "kilo-vscode"), { recursive: true })
  await fs.mkdir(path.join(root, "packages", "opencode"), { recursive: true })
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, "keep.txt"), "unrelated user work")
  for (const [file, data] of [
    ["package.json", { name: "@kilocode/kilo" }],
    ["packages/opencode/package.json", { name: "@kilocode/cli" }],
    ["packages/kilo-vscode/package.json", { name: "raya", publisher: "eden" }],
  ] as const)
    await fs.writeFile(path.join(root, file), JSON.stringify(data))
  await git(root, ["init"])
  await git(root, ["add", "."])
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"])
  return {
    dir,
    root,
    workspace,
    store,
    async [Symbol.asyncDispose]() {
      if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("raya-self-heal-"))
        throw new Error("unexpected fixture path")
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}
function client() {
  const calls: Request[] = []
  const item = {
    id: "heal_fixture",
    title: "Fixture issue",
    description: "Fixture issue description",
    category: "other",
    severity: "low",
    approach: "Reproduce",
    status: "triaged",
  }
  const sdk = createKiloClient({
    baseUrl: "http://unused.invalid",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      const url = new URL(request.url)
      if (url.pathname === "/kilocode/self-heal") return Response.json(item)
      if (url.pathname === "/session") return Response.json({ id: "repair-session" })
      if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
      return Response.json({})
    },
  })
  return { sdk, calls }
}

test("source verification accepts only a committed Raya Git root and preserves its identity", async () => {
  await using run = await fixture()
  const expected = await fs.realpath(run.root)
  const source = await resolve({ configured: run.root, extension: "installed-extension" })
  expect(source).toEqual({ ok: true, source: { root: expected, commit: await git(run.root, ["rev-parse", "HEAD"]) } })
  expect(await resolve({ configured: "", extension: path.join(run.root, "packages", "kilo-vscode") })).toEqual(source)
  expect((await resolve({ configured: path.join(run.root, "packages", "opencode"), extension: "" })).ok).toBe(false)
  expect((await resolve({ configured: "relative/source", extension: "" })).ok).toBe(false)
  await fs.writeFile(
    path.join(run.root, "packages", "kilo-vscode", "package.json"),
    JSON.stringify({ name: "other", publisher: "eden" }),
  )
  expect((await resolve({ configured: run.root, extension: "" })).ok).toBe(false)
}, 30_000)

test("an explicit missing source never falls back to an otherwise valid development checkout", async () => {
  await using run = await fixture()
  const result = await resolve({
    configured: path.join(run.dir, "missing"),
    extension: path.join(run.root, "packages", "kilo-vscode"),
  })
  expect(result.ok).toBe(false)
  expect((await resolve({ configured: "", extension: path.join(run.dir, "installed-extension") })).ok).toBe(false)
}, 30_000)

test("missing source saves intake in global context and performs no repair calls in the unrelated project", async () => {
  await using run = await fixture()
  for (const configured of ["", path.join(run.dir, "missing"), run.workspace]) {
    const api = client()
    let metadata = 0
    const result = await capture({
      client: api.sdk,
      store: run.store,
      configured,
      extension: path.join(run.dir, "installed-extension"),
      description: "Reported issue",
      reporter: "reporter",
      metadata: async () => {
        metadata++
        return undefined
      },
    })
    expect(result.session).toBeUndefined()
    expect(result.notice).toContain("saved to the global backlog")
    expect(result.notice).toContain("Repair was not started")
    expect(result.notice).toContain("raya.selfHeal.sourcePath")
    expect(api.calls).toHaveLength(1)
    expect(new URL(api.calls[0]!.url).searchParams.get("directory")).toBe(run.store)
    expect(await api.calls[0]!.json()).toEqual({ description: "Reported issue", reporterSessionID: "reporter" })
    expect(metadata).toBe(0)
  }
  expect(await fs.readdir(run.workspace)).toEqual(["keep.txt"])
  expect(await fs.readFile(path.join(run.workspace, "keep.txt"), "utf8")).toBe("unrelated user work")
}, 30_000)

test("valid source admission binds all repair requests and records the observed source commit", async () => {
  await using run = await fixture()
  const api = client()
  const root = await fs.realpath(run.root)
  const commit = await git(root, ["rev-parse", "HEAD"])
  const result = await capture({
    client: api.sdk,
    store: run.store,
    configured: root,
    extension: "",
    description: "Reported issue",
    reporter: "reporter",
    metadata: async (directory) => {
      expect(directory).toBe(root)
      return { sandbox: true }
    },
  })
  expect(result.session).toBe("repair-session")
  expect(result.source).toEqual({ root, commit })
  expect(result.notice).not.toContain("isolated")
  expect(api.calls).toHaveLength(5)
  const session = api.calls[1]!
  expect(new URL(session.url).searchParams.get("directory")).toBe(root)
  expect(await session.json()).toMatchObject({ metadata: { sandbox: true, rayaSelfHealSource: { root, commit } } })
  expect(new URL(api.calls[2]!.url).searchParams.get("directory")).toBe(root)
  expect(new URL(api.calls[3]!.url).searchParams.get("directory")).toBe(run.store)
  expect(new URL(api.calls[4]!.url).searchParams.get("directory")).toBe(root)
  expect(JSON.stringify(await api.calls[4]!.json())).toContain(commit)
  expect(await fs.readFile(path.join(run.workspace, "keep.txt"), "utf8")).toBe("unrelated user work")
}, 30_000)

test("a source revision changing before admission keeps the report without creating a repair", async () => {
  await using run = await fixture()
  const api = client()
  const source = await resolve({ configured: run.root, extension: "" })
  if (!source.ok) throw new Error(source.reason)
  const result = await capture({
    client: api.sdk,
    store: run.store,
    configured: run.root,
    extension: "",
    description: "Reported issue",
    reporter: "reporter",
    metadata: async () => {
      await git(run.root, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "changed source",
      ])
      return undefined
    },
  })
  expect(result.session).toBeUndefined()
  expect(result.notice).toContain("source changed or became unavailable")
  expect(api.calls).toHaveLength(1)
  expect(await current(source.source)).toBe(false)
}, 30_000)

test("inherited mixed-case Git environment overrides cannot redirect source verification", async () => {
  await using run = await fixture()
  const prior = { dir: process.env.Git_Dir, work: process.env.Git_Work_Tree }
  process.env.Git_Dir = path.join(run.dir, "missing-git")
  process.env.Git_Work_Tree = run.workspace
  try {
    const result = await resolve({ configured: run.root, extension: "" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.source.root).toBe(await fs.realpath(run.root))
  } finally {
    if (prior.dir === undefined) delete process.env.Git_Dir
    else process.env.Git_Dir = prior.dir
    if (prior.work === undefined) delete process.env.Git_Work_Tree
    else process.env.Git_Work_Tree = prior.work
  }
}, 30_000)

test("uncommitted Raya-looking manifests cannot establish source identity for another committed product", async () => {
  await using run = await fixture()
  const manifest = path.join(run.root, "packages", "kilo-vscode", "package.json")
  await fs.writeFile(manifest, JSON.stringify({ name: "other", publisher: "elsewhere" }))
  await git(run.root, ["add", "."])
  await git(run.root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "other product",
  ])
  await fs.writeFile(manifest, JSON.stringify({ name: "raya", publisher: "eden" }))
  expect((await resolve({ configured: run.root, extension: "" })).ok).toBe(false)
}, 30_000)

test("a configured source link changing during preparation cannot redirect or retain repair authority", async () => {
  await using run = await fixture()
  const alias = path.join(run.dir, "registered-source")
  await fs.symlink(run.root, alias, process.platform === "win32" ? "junction" : "dir")
  const api = client()
  const result = await capture({
    client: api.sdk,
    store: run.store,
    configured: alias,
    extension: "",
    description: "Reported issue",
    reporter: "reporter",
    metadata: async () => {
      expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true)
      await fs.unlink(alias)
      await fs.symlink(run.workspace, alias, process.platform === "win32" ? "junction" : "dir")
      return undefined
    },
  })
  expect(result.session).toBeUndefined()
  expect(result.notice).toContain("source changed or became unavailable")
  expect(api.calls).toHaveLength(1)
  expect(await fs.readdir(run.workspace)).toEqual(["keep.txt"])
}, 30_000)
