import { expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { exec } from "../../src/util/process"
import { resolve, current } from "../../src/self-heal/source"
import { summary, inspect } from "../../src/self-heal/summary"
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
function client(
  opts: {
    failure?: string
    reporting?: boolean
    owned?: boolean
    acknowledgement?: string
    blocked?: string
    unknown?: boolean
  } = {},
) {
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
  let outcome = {
    id: "attempt",
    itemID: item.id,
    source: { root: "", commit: "" },
    worktree: undefined as
      | { root: string; directory: string; branch: string; common: string; commit: string }
      | undefined,
    reason: undefined as string | undefined,
    phase: "reserved",
    revision: 0,
    at: 1,
  }
  const fails = (pathname: string) => opts.failure && pathname.endsWith(opts.failure)
  const sdk = createKiloClient({
    baseUrl: "http://unused.invalid",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      const url = new URL(request.url)
      if (fails(url.pathname)) return Response.json({ error: "private raw backend failure" }, { status: 500 })
      if (url.pathname === "/kilocode/self-heal") return Response.json(item)
      if (url.pathname.endsWith("/repair/worktree")) {
        const root = path.dirname(outcome.source.root)
        outcome = {
          ...outcome,
          phase: opts.unknown ? "worktree_unknown" : "worktree_ready",
          revision: 2,
          worktree: {
            root,
            directory: path.join(root, "repair"),
            branch: "raya/repair/attempt",
            common: path.join(outcome.source.root, ".git"),
            commit: outcome.source.commit,
          },
          ...(opts.unknown ? { reason: "Checkout creation is uncertain; inspect the retained directory." } : {}),
        }
        if (opts.acknowledgement === "worktree_ready") return Response.json({}, { status: 500 })
        return Response.json(outcome)
      }
      if (url.pathname.endsWith("/repair/step")) {
        const body = await request.clone().json()
        if (["blocked", "worktree_unknown", "submitted"].includes(outcome.phase))
          return Response.json({}, { status: 409 })
        if (body.revision !== outcome.revision) return Response.json({}, { status: 409 })
        if (opts.reporting === false && ["blocked", "dispatch_unknown"].includes(body.phase))
          return Response.json({}, { status: 500 })
        outcome = {
          ...outcome,
          phase: opts.blocked === body.phase ? "blocked" : body.phase,
          ...(opts.blocked === body.phase
            ? { reason: "Checkout verification failed before the dependent operation." }
            : {}),
          revision: outcome.revision + 1,
          ...(body.sessionID ? { sessionID: body.sessionID } : {}),
        }
        if (opts.acknowledgement === body.phase) return Response.json({}, { status: 500 })
        return Response.json(outcome)
      }
      if (url.pathname.endsWith("/repair")) {
        outcome.source = (await request.clone().json()).source
        return Response.json({
          owned: opts.owned !== false,
          ...(opts.owned === false ? {} : { token: "owner" }),
          outcome,
        })
      }
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
  expect(api.calls).toHaveLength(13)
  const directory = path.join(run.dir, "repair")
  expect(result.directory).toBe(directory)
  const effects = api.calls.filter((call) => !new URL(call.url).pathname.includes("/self-heal/heal_fixture/repair"))
  const session = effects[1]!
  expect(new URL(session.url).searchParams.get("directory")).toBe(directory)
  expect(await session.json()).toMatchObject({ metadata: { sandbox: true, rayaSelfHealSource: { root, commit } } })
  expect(new URL(effects[2]!.url).searchParams.get("directory")).toBe(directory)
  expect(new URL(effects[3]!.url).searchParams.get("directory")).toBe(run.store)
  expect(new URL(effects[4]!.url).searchParams.get("directory")).toBe(directory)
  expect(JSON.stringify(await effects[4]!.json())).toContain(commit)
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

test("duplicate repair admission creates no additional session or dispatch", async () => {
  await using run = await fixture()
  const api = client({ owned: false })
  const result = await capture({
    client: api.sdk,
    store: run.store,
    configured: run.root,
    extension: "",
    description: "Repeated issue report",
    reporter: "reporter",
    metadata: async () => undefined,
  })
  expect(result.session).toBeUndefined()
  expect(api.calls).toHaveLength(2)
  expect(result.notice).toContain("No additional repair was started")
}, 30_000)

test("startup failures retain their phase without repeating side effects or exposing raw errors", async () => {
  await using run = await fixture()
  for (const failure of ["/session", "/goal", "/heal_fixture", "/prompt_async"]) {
    const api = client({ failure })
    const result = await capture({
      client: api.sdk,
      store: run.store,
      configured: run.root,
      extension: "",
      description: "Startup boundary failed",
      reporter: "reporter",
      metadata: async () => undefined,
    })
    expect(result.session).toBeUndefined()
    expect(result.notice).toContain("startup needs review")
    expect(result.notice).not.toContain("private raw")
    const calls = api.calls.filter((call) => new URL(call.url).pathname.endsWith(failure))
    expect(calls).toHaveLength(1)
    const last = await api.calls.at(-1)!.clone().json()
    expect(last.phase).toBe(failure === "/prompt_async" ? "dispatch_unknown" : "blocked")
  }
}, 30_000)

test("unavailable failure reporting leaves a readable retained phase notice and never replays dispatch", async () => {
  await using run = await fixture()
  const api = client({ failure: "/prompt_async", reporting: false })
  const result = await capture({
    client: api.sdk,
    store: run.store,
    configured: run.root,
    extension: "",
    description: "Dispatch acknowledgement lost",
    reporter: "reporter",
    metadata: async () => undefined,
  })
  expect(result.notice).toContain("last durable phase")
  expect(result.notice).toContain("repair-session")
  expect(api.calls.filter((call) => new URL(call.url).pathname.endsWith("/prompt_async"))).toHaveLength(1)
}, 30_000)

test("backlog summary exposes retained startup outcome and authoritative attempt session", () => {
  const text = summary({
    id: "heal",
    status: "in_progress",
    category: "other",
    severity: "high",
    title: "Issue",
    workSessionID: "old",
    repair: { phase: "dispatch_unknown", sessionID: "retained", reason: "Do not replay dispatch." },
  })
  expect(text).toContain("repair dispatch_unknown: Do not replay dispatch.")
  expect(text).toContain("session retained")
  expect(text).not.toContain("session old")
})

test("lost phase acknowledgements never authorize their dependent side effects", async () => {
  await using run = await fixture()
  for (const acknowledgement of ["session_creating", "dispatching"]) {
    const api = client({ acknowledgement })
    const result = await capture({
      client: api.sdk,
      store: run.store,
      configured: run.root,
      extension: "",
      description: "Phase acknowledgement lost",
      reporter: "reporter",
      metadata: async () => undefined,
    })
    expect(result.notice).toContain("last durable phase")
    const forbidden = acknowledgement === "session_creating" ? "/session" : "/prompt_async"
    expect(api.calls.filter((call) => new URL(call.url).pathname.endsWith(forbidden))).toHaveLength(0)
  }
}, 30_000)

test("inspect reads the journal directly and handles missing outcomes without assuming release", async () => {
  const calls: Request[] = []
  const fails = (pathname: string) => opts.failure && pathname.endsWith(opts.failure)
  const sdk = createKiloClient({
    baseUrl: "http://unused.invalid",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return calls.length === 1
        ? Response.json({
            id: "attempt",
            itemID: "heal_missing",
            phase: "dispatch_unknown",
            sessionID: "retained",
            reason: "Do not replay.",
          })
        : new Response(null, { status: 404 })
    },
  })
  expect(await inspect(sdk, "heal_missing", "global")).toContain("dispatch_unknown in session retained. Do not replay.")
  expect(new URL(calls[0].url).pathname).toBe("/kilocode/self-heal/heal_missing/repair")
  expect(calls[0].method).toBe("GET")
  expect(await inspect(sdk, "heal_missing", "global")).toContain("do not infer that its ownership was released")
})

test("unknown worktree creation is inspectable and never starts a session or retries preparation", async () => {
  await using run = await fixture()
  const api = client({ unknown: true })
  const result = await capture({
    client: api.sdk,
    store: run.store,
    configured: run.root,
    extension: "",
    description: "Worktree creation is uncertain",
    reporter: "reporter",
    metadata: async () => undefined,
  })
  expect(result.session).toBeUndefined()
  expect(result.notice).toContain(path.join(run.dir, "repair"))
  expect(result.notice).toContain("creation is uncertain")
  expect(api.calls.filter((call) => new URL(call.url).pathname === "/session")).toHaveLength(0)
  expect(api.calls.filter((call) => new URL(call.url).pathname.endsWith("/repair/worktree"))).toHaveLength(1)
}, 30_000)

test("backend checkout denial prevents its dependent session or prompt request", async () => {
  await using run = await fixture()
  for (const blocked of ["session_creating", "dispatching"]) {
    const api = client({ blocked })
    const result = await capture({
      client: api.sdk,
      store: run.store,
      configured: run.root,
      extension: "",
      description: "Checkout changed before work",
      reporter: "reporter",
      metadata: async () => undefined,
    })
    expect(result.session).toBeUndefined()
    expect(result.notice).toContain("Checkout verification failed")
    const suffix = blocked === "session_creating" ? "/session" : "/prompt_async"
    expect(api.calls.filter((call) => new URL(call.url).pathname.endsWith(suffix))).toHaveLength(0)
  }
}, 30_000)

test("self-heal summary distinguishes tested evidence, legacy claims and delivery", () => {
  const item = { id: "heal_tested", status: "verified", category: "ui", severity: "low", title: "Issue" }
  expect(summary(item)).toContain("Legacy verification claim; evidence needs review")
  expect(summary({ ...item, status: "blocked", legacyVerification: true })).toContain("Legacy verification claim")
  expect(summary({ ...item, completion: { attemptID: "attempt", at: 1 } })).toContain(
    "Fix tested; not released or installed",
  )
})
