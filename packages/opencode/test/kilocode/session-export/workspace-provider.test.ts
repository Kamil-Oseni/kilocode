import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir as osTmpdir } from "node:os"
import { join, resolve } from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { createWorkspaceProvider } from "@/kilocode/session-export/workspace-provider"

function processState(root: string, state: string, dir: string, name: string, session: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "fixtures/workspace-state-process.ts"),
      root,
      state,
      dir,
      name,
      session,
    ],
    { cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true },
  )
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timer = setTimeout(() => child.kill(), 30_000)
  return {
    wait(name: string) {
      return Promise.race([
        gate(dir, name),
        child.exited.then(async () => {
          const [stdout, stderr] = await output
          throw new Error(`Workspace state child exited before ${name}: ${stdout}${stderr}`)
        }),
      ])
    },
    async result(): Promise<{ ok: boolean; id?: string; error?: string; pid: number }> {
      const code = await child.exited
      const [stdout, stderr] = await output
      expect(code, stdout + stderr).toBe(0)
      return JSON.parse(stdout)
    },
    async [Symbol.asyncDispose]() {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      await child.exited
      await output
    },
  }
}

async function gate(dir: string, name: string) {
  const file = join(dir, name)
  const deadline = Date.now() + 15_000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() >= deadline) throw new Error(`Missing workspace state gate: ${name}`)
    await Bun.sleep(10)
  }
  return Bun.file(file).text()
}

describe("workspace provider", () => {
  test("does not start Git for a nonrepository with no executable PATH", async () => {
    await using tmp = await tmpdir()
    const module = resolve(import.meta.dir, "../../../src/kilocode/session-export/workspace-provider.ts")
    const script = `import { createWorkspaceProvider } from ${JSON.stringify(module)}; const result = await createWorkspaceProvider({root:process.argv[1]}).baseline(); console.log(JSON.stringify({mode:result.capture.mode,count:result.files.length}));`
    const child = Bun.spawn([process.execPath, "--eval", script, tmp.path], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...process.env, PATH: "", Path: "", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      windowsHide: true,
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ mode: "none", count: 0 })
  })

  test("refuses a lock held by another process and recovers after it releases", async () => {
    await using repo = await tmpdir({ git: true })
    await using dir = await tmpdir()
    const state = join(dir.path, "state.json")
    await writeFile(join(repo.path, "src.ts"), "export const value = 1\n")
    await using child = processState(repo.path, state, dir.path, "holder", "__lock__")
    await child.wait("holder.loaded")
    const provider = createWorkspaceProvider({ root: repo.path, statePath: state })
    const err = await provider.baseline().then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err instanceof Error ? err.message : "").toBe("Workspace state lock unavailable")
    expect(await Bun.file(state).exists()).toBe(false)
    await Bun.write(join(dir.path, "holder.commit"), "go")
    expect((await child.result()).ok).toBe(true)
    const baseline = await provider.baseline()
    provider.remember("session", baseline.snapshotId)
    expect(createWorkspaceProvider({ root: repo.path, statePath: state }).current("session")).toBe(baseline.snapshotId)
    expect(await Bun.file(`${state}.lock`).exists()).toBe(false)
  }, 40_000)

  test("independent processes merge concurrent captures and survive a fresh provider", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    await using dir = await tmpdir()
    const state = join(dir.path, "state.json")
    await writeFile(join(first.path, "first.ts"), "export const first = true\n")
    await writeFile(join(second.path, "second.ts"), "export const second = true\n")
    await using a = processState(first.path, state, dir.path, "a", "first")
    await using b = processState(second.path, state, dir.path, "b", "second")
    await Promise.all([a.wait("a.loaded"), b.wait("b.loaded")])
    await Bun.write(join(dir.path, "capture"), "go")
    const [one, two] = await Promise.all([a.wait("a.captured"), b.wait("b.captured")])
    await Promise.all([Bun.write(join(dir.path, "a.commit"), "go"), Bun.write(join(dir.path, "b.commit"), "go")])
    const [left, right] = await Promise.all([a.result(), b.result()])
    expect(left.ok).toBe(true)
    expect(right.ok).toBe(true)
    expect(left.pid).not.toBe(right.pid)
    expect(left.pid).not.toBe(process.pid)
    expect(left.id).toBe(one)
    expect(right.id).toBe(two)
    const persisted = await Bun.file(state).json()
    expect(persisted.sessions).toEqual({ first: one, second: two })
    expect(Object.keys(persisted.snapshots).sort()).toEqual([one, two].sort())
    expect(persisted.pending).toEqual({})
    const fresh = createWorkspaceProvider({ root: first.path, statePath: state })
    expect(fresh.current("first")).toBe(one)
    expect(fresh.current("second")).toBe(two)
    expect(await Bun.file(`${state}.lock`).exists()).toBe(false)
  }, 40_000)

  test("a stale independent process cannot overwrite another process's session", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    await using dir = await tmpdir()
    const state = join(dir.path, "state.json")
    await writeFile(join(first.path, "first.ts"), "first\n")
    await writeFile(join(second.path, "second.ts"), "second\n")
    await using a = processState(first.path, state, dir.path, "a", "same")
    await using b = processState(second.path, state, dir.path, "b", "same")
    await Promise.all([a.wait("a.loaded"), b.wait("b.loaded")])
    await Bun.write(join(dir.path, "capture"), "go")
    const [one, two] = await Promise.all([a.wait("a.captured"), b.wait("b.captured")])
    await Bun.write(join(dir.path, "a.commit"), "go")
    expect((await a.result()).ok).toBe(true)
    const bytes = await Bun.file(state).text()
    await Bun.write(join(dir.path, "b.commit"), "go")
    const result = await b.result()
    expect(result.ok).toBe(false)
    expect(result.error).toBe("Workspace state changed for session")
    expect(await Bun.file(state).text()).toBe(bytes)
    const persisted = JSON.parse(bytes)
    expect(persisted.sessions).toEqual({ same: one })
    expect(persisted.snapshots[two]).toBeDefined()
    expect(persisted.pending[two]).toHaveLength(1)
    expect(await Bun.file(`${state}.lock`).exists()).toBe(false)
  }, 40_000)

  test("an independent process refuses corrupt state without rewriting it", async () => {
    await using repo = await tmpdir({ git: true })
    await using dir = await tmpdir()
    const state = join(dir.path, "state.json")
    const bytes = '{"sessions":{"same":"missing"},"snapshots":{}}'
    await writeFile(state, bytes)
    await using child = processState(repo.path, state, dir.path, "a", "same")
    const result = await child.result()
    expect(result.ok).toBe(false)
    expect(result.error).toBe("Invalid workspace session")
    expect(await Bun.file(state).text()).toBe(bytes)
    expect(await Bun.file(`${state}.lock`).exists()).toBe(false)
  }, 40_000)

  test("captures the repository root when started from a nested git directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await mkdir(join(tmp.path, "src", "nested"), { recursive: true })
    await writeFile(join(tmp.path, "package.json"), '{"name":"repo"}\n')
    await writeFile(join(tmp.path, "src", "nested", "index.ts"), "export const nested = true\n")
    await $`git add package.json src/nested/index.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: join(tmp.path, "src", "nested") })
    const baseline = await provider.baseline()

    expect(baseline.capture.mode).toBe("git-tracked-and-untracked")
    expect(baseline.files.map((file) => file.path)).toEqual(["package.json", "src/nested/index.ts"])
    expect(baseline.files.find((file) => file.path === "package.json")?.content).toBe('{"name":"repo"}\n')
  })

  test("does not capture filesystem files outside a git repository", async () => {
    await using tmp = await tmpdir()
    await writeFile(join(tmp.path, "loose.txt"), "do not sync me\n")

    const provider = createWorkspaceProvider({ root: tmp.path })
    const baseline = await provider.baseline()

    expect(baseline.capture).toEqual({
      mode: "none",
      fileCount: 0,
      totalBytes: 0,
      omittedCountsByReason: {},
      truncated: false,
    })
    expect(baseline.files).toEqual([])
  })

  test("rechecks malformed markers and later repository creation", async () => {
    await using tmp = await tmpdir()
    const provider = createWorkspaceProvider({ root: tmp.path })
    expect((await provider.baseline()).capture.mode).toBe("none")
    await writeFile(join(tmp.path, ".git"), "not a git directory\n")
    expect((await provider.baseline()).capture.mode).toBe("none")
    const store = join(tmp.path, "store")
    const repo = join(tmp.path, "checkout")
    await $`git init --separate-git-dir=${store} ${repo}`.quiet()
    await mkdir(join(repo, "nested"))
    await writeFile(join(repo, "nested", "file.txt"), "authorized file\n")
    const nested = createWorkspaceProvider({ root: join(repo, "nested") })
    const result = await nested.baseline()
    expect(result.capture.mode).toBe("git-tracked-and-untracked")
    expect(result.files.map((file) => file.path)).toEqual(["nested/file.txt"])
  })

  test("preserves an explicitly configured external Git directory", async () => {
    await using tmp = await tmpdir()
    const store = join(tmp.path, "store.git")
    const root = join(tmp.path, "files")
    await $`git init --bare ${store}`.quiet()
    await mkdir(root)
    await writeFile(join(root, "file.txt"), "authorized file\n")
    const module = resolve(import.meta.dir, "../../../src/kilocode/session-export/workspace-provider.ts")
    const script = `import { createWorkspaceProvider } from ${JSON.stringify(module)}; const result = await createWorkspaceProvider({root:process.argv[1]}).baseline(); console.log(JSON.stringify({mode:result.capture.mode,files:result.files.map(file=>file.path)}));`
    const child = Bun.spawn([process.execPath, "--eval", script, root], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...process.env, GIT_DIR: store, GIT_WORK_TREE: root },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      windowsHide: true,
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ mode: "git-tracked-and-untracked", files: ["file.txt"] })
  })

  test("captures initial filesystem state and ignores gitignored files", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeFile(join(tmp.path, ".gitignore"), "ignored.txt\n")
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    await writeFile(join(tmp.path, "ignored.txt"), "nope\n")
    await $`git add .gitignore src.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: tmp.path })
    const baseline = await provider.baseline()

    expect(baseline.snapshotId).toBeTruthy()
    expect(baseline.files.map((file) => file.path)).toEqual([".gitignore", "src.ts"])
    expect(baseline.files.find((file) => file.path === "src.ts")?.content).toBe("export const value = 1\n")
  })

  test("baseline includes capture completeness metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    await writeFile(join(tmp.path, ".env"), "SECRET=1\n")
    await $`git add src.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: tmp.path })
    const baseline = await provider.baseline()

    expect(baseline.capture).toEqual({
      mode: "git-tracked-and-untracked",
      fileCount: 2,
      totalBytes: 32,
      omittedCountsByReason: { high_risk_path: 1 },
      truncated: false,
    })
  })

  test("truncates workspace content past aggregate snapshot budget", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeFile(join(tmp.path, "a.ts"), "aaaa\n")
    await writeFile(join(tmp.path, "b.ts"), "bbbb\n")
    await $`git add a.ts b.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: tmp.path, maxSnapshotBytes: 5 })
    const baseline = await provider.baseline()

    expect(baseline.capture.truncated).toBe(true)
    expect(baseline.capture.omittedCountsByReason.large).toBe(1)
    expect(baseline.files.map((file) => [file.path, file.content, file.omitted?.reason])).toEqual([
      ["a.ts", "aaaa\n", undefined],
      ["b.ts", undefined, "large"],
    ])
  })

  test("baseline capture metadata never embeds the absolute workspace root", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    await $`git add src.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: tmp.path })
    const baseline = await provider.baseline()

    expect(JSON.stringify(baseline.capture)).not.toContain(tmp.path)
    expect(JSON.stringify(baseline.files)).not.toContain(tmp.path)
  })

  test("omits high-risk file contents before persistence", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(join(tmp.path, ".env"), "SECRET=AKIAIOSFODNN7EXAMPLE\n")

    const provider = createWorkspaceProvider({ root: tmp.path, statePath: state })
    const baseline = await provider.baseline()

    expect(baseline.files[0]).toEqual({
      path: ".env",
      kind: "file",
      size: 28,
      omitted: { reason: "high_risk_path" },
    })
    await expect(Bun.file(state).text()).resolves.not.toContain("AKIAIOSFODNN7EXAMPLE")
  })

  test("does not persist ordinary source contents in snapshot state", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(join(tmp.path, "src.ts"), "export const secret = 'local-only'\n")
    await $`git add src.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: tmp.path, statePath: state })
    const baseline = await provider.baseline()

    expect(baseline.files[0].content).toContain("local-only")
    await expect(Bun.file(state).text()).resolves.not.toContain("local-only")
  })

  test("does not follow symlink contents outside the repository", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = await mkdtemp(join(osTmpdir(), "session-export-provider-"))
    const secret = join(dir, "secret.txt")
    await writeFile(secret, "outside-secret\n")
    await symlink(secret, join(tmp.path, "link.txt"))
    await $`git add link.txt`.cwd(tmp.path).quiet()
    await $`git commit -m link`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: tmp.path })
    const baseline = await provider.baseline()
    const link = baseline.files.find((file) => file.path === "link.txt")

    expect(link?.kind).toBe("symlink")
    expect(link?.content).toBeUndefined()
    expect(JSON.stringify(baseline)).not.toContain("outside-secret")
  })

  test("captures diffs from the previous snapshot", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    await $`git add src.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: tmp.path })
    const baseline = await provider.baseline()

    await writeFile(join(tmp.path, "src.ts"), "export const value = 2\n")
    await writeFile(join(tmp.path, "new.ts"), "export const next = true\n")

    const delta = await provider.diff(baseline.snapshotId)

    expect(delta.snapshotHash).not.toBe(baseline.snapshotId)
    expect(delta.diff.map((item) => [item.path, item.status])).toEqual([
      ["new.ts", "added"],
      ["src.ts", "modified"],
    ])
    expect(delta.diff.every((item) => item.patch?.includes("export const"))).toBe(true)
  })

  test("evicts a session's previous snapshot when a new one is remembered", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    await $`git add src.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: tmp.path, statePath: state })
    const first = await provider.baseline()
    provider.remember("s1", first.snapshotId)

    await writeFile(join(tmp.path, "src.ts"), "export const value = 2\n")
    const delta = await provider.diff(first.snapshotId)
    provider.remember("s1", delta.snapshotHash)

    const persisted = JSON.parse(await Bun.file(state).text()) as { snapshots: Record<string, unknown> }
    expect(Object.keys(persisted.snapshots)).toEqual([delta.snapshotHash])
  })

  test("prunes unreferenced snapshots when a session snapshot is remembered", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    await $`git add src.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: tmp.path, statePath: state })
    const stale = await provider.baseline()

    await writeFile(join(tmp.path, "src.ts"), "export const value = 2\n")
    const current = await provider.baseline()
    provider.remember("s1", current.snapshotId)

    const persisted = JSON.parse(await Bun.file(state).text()) as { snapshots: Record<string, unknown> }
    expect(persisted.snapshots[stale.snapshotId]).toBeUndefined()
    expect(Object.keys(persisted.snapshots)).toEqual([current.snapshotId])
  })

  test("preserves captured snapshots until they are remembered", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    await $`git add src.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: tmp.path, statePath: state })
    const first = await provider.baseline()
    provider.remember("s1", first.snapshotId)

    await writeFile(join(tmp.path, "src.ts"), "export const value = 2\n")
    const pending = await provider.baseline()
    provider.remember("s2", first.snapshotId)

    const persisted = JSON.parse(await Bun.file(state).text()) as { snapshots: Record<string, unknown> }
    expect(Object.keys(persisted.snapshots).sort()).toEqual([first.snapshotId, pending.snapshotId].sort())
  })

  test("preserves a snapshot still referenced by another session", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    await $`git add src.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const provider = createWorkspaceProvider({ root: tmp.path, statePath: state })
    const shared = await provider.baseline()
    provider.remember("s1", shared.snapshotId)
    provider.remember("s2", shared.snapshotId)

    await writeFile(join(tmp.path, "src.ts"), "export const value = 2\n")
    const delta = await provider.diff(shared.snapshotId)
    provider.remember("s1", delta.snapshotHash)

    const persisted = JSON.parse(await Bun.file(state).text()) as { snapshots: Record<string, unknown> }
    expect(Object.keys(persisted.snapshots).sort()).toEqual([shared.snapshotId, delta.snapshotHash].sort())
  })

  test("persists session snapshot state across provider instances", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    await $`git add src.ts`.cwd(tmp.path).quiet()
    await $`git commit -m files`.cwd(tmp.path).quiet()

    const first = createWorkspaceProvider({ root: tmp.path, statePath: state })
    const baseline = await first.baseline()
    first.remember("s1", baseline.snapshotId)

    await writeFile(join(tmp.path, "src.ts"), "export const value = 2\n")

    const second = createWorkspaceProvider({ root: tmp.path, statePath: state })
    expect(second.current("s1")).toBe(baseline.snapshotId)
    const delta = await second.diff(second.current("s1")!)
    expect(delta.diff[0].path).toBe("src.ts")
    expect(delta.diff[0].patch).toContain("value = 2")
  })

  test("refuses corrupt persisted snapshot state", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(state, JSON.stringify({ sessions: { s1: "bad" }, snapshots: { bad: { path: "src.ts" } } }))

    expect(() => createWorkspaceProvider({ root: tmp.path, statePath: state })).toThrow("Invalid workspace snapshot")
    expect(await Bun.file(state).text()).toContain('"s1":"bad"')
  })

  test("independent providers preserve different sessions and snapshots after concurrent captures", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(join(first.path, "first.ts"), "export const first = true\n")
    await writeFile(join(second.path, "second.ts"), "export const second = true\n")
    const a = createWorkspaceProvider({ root: first.path, statePath: state })
    const b = createWorkspaceProvider({ root: second.path, statePath: state })

    const [one, two] = await Promise.all([a.baseline(), b.baseline()])
    expect(one.snapshotId).not.toBe(two.snapshotId)
    a.remember("first", one.snapshotId)
    b.remember("second", two.snapshotId)

    const persisted = JSON.parse(await Bun.file(state).text()) as {
      sessions: Record<string, string>
      snapshots: Record<string, unknown>
    }
    expect(persisted.sessions).toEqual({ first: one.snapshotId, second: two.snapshotId })
    expect(Object.keys(persisted.snapshots).sort()).toEqual([one.snapshotId, two.snapshotId].sort())
    const reopened = createWorkspaceProvider({ root: first.path, statePath: state })
    expect(reopened.current("first")).toBe(one.snapshotId)
    expect(reopened.current("second")).toBe(two.snapshotId)
  })

  test("diffs from a snapshot published by an independent provider", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    const a = createWorkspaceProvider({ root: tmp.path, statePath: state })
    const b = createWorkspaceProvider({ root: tmp.path, statePath: state })
    const first = await a.baseline()
    a.remember("shared", first.snapshotId)
    await writeFile(join(tmp.path, "src.ts"), "export const value = 2\n")

    const id = b.current("shared")
    expect(id).toBe(first.snapshotId)
    const result = await b.diff(id!)
    expect(result.diff.map((item) => [item.path, item.status])).toEqual([["src.ts", "modified"]])
    expect(result.diff[0].patch).toContain("value = 2")
  })

  test("refuses a stale provider changing a session another provider advanced", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    const a = createWorkspaceProvider({ root: tmp.path, statePath: state })
    const b = createWorkspaceProvider({ root: tmp.path, statePath: state })
    const first = await a.baseline()
    a.remember("same", first.snapshotId)
    await writeFile(join(tmp.path, "src.ts"), "export const value = 2\n")
    const next = await b.baseline()

    expect(() => b.remember("same", next.snapshotId)).toThrow("Workspace state changed for session")
    expect(b.current("same")).toBe(first.snapshotId)
    b.remember("same", next.snapshotId)
    expect(a.current("same")).toBe(next.snapshotId)
  })

  test("refuses publication while a lock is held without altering state", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = join(await mkdtemp(join(osTmpdir(), "session-export-provider-")), "state.json")
    await writeFile(join(tmp.path, "src.ts"), "export const value = 1\n")
    const provider = createWorkspaceProvider({ root: tmp.path, statePath: state })
    await writeFile(`${state}.lock`, "held")

    await expect(provider.baseline()).rejects.toThrow("Workspace state lock unavailable")
    expect(await Bun.file(state).exists()).toBe(false)
  })
})
