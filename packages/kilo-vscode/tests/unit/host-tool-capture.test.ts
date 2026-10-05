import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { ProjectContexts } from "../../src/agent-manager/project/contexts"
import { HostCapture } from "../../src/kilo-provider/host-capture"
import { handleToolEvent } from "../../src/agent-manager/tool-project"
import { startFromTool } from "../../src/agent-manager/tool-start"
import { createWorktreeOnDisk } from "../../src/agent-manager/worktree-create"
import { registerWorktreeSession } from "../../src/agent-manager/worktree-session"
import { WorktreeManager } from "../../src/agent-manager/WorktreeManager"
import { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"
import { SetupScriptService } from "../../src/agent-manager/SetupScriptService"
import { SetupScriptRunner } from "../../src/agent-manager/SetupScriptRunner"
import { copyEnvFiles } from "../../src/agent-manager/env-copy"

const client = () => createKiloClient({ baseUrl: "http://127.0.0.1:1" })
function native(command: string, args: string[], root: string, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  const chunks: Buffer[] = []
  child.stdout.on("data", (data: Buffer) => chunks.push(data))
  child.stderr.resume()
  const ready = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve)
    child.once("error", reject)
  })
  return { child, ready, done, output: () => Buffer.concat(chunks).toString().trim() }
}
async function git(root: string, args: string[]) {
  const proc = native("git", ["-c", "core.hooksPath=", "-C", root, ...args], root)
  await proc.ready
  proc.child.stdin.end()
  assert.equal(await proc.done, 0)
  return proc.output()
}

test("tool event reserves before routing and joins real worktree, held Git, and metadata publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-host-tool-"))
  await git(root, ["init", "--quiet", "--template="])
  await writeFile(path.join(root, "file.txt"), "private fixture\n")
  await git(root, ["add", "file.txt"])
  await git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ])
  const manager = new WorktreeManager(root, () => undefined)
  const contexts = new ProjectContexts({
    workspaceRoot: () => root,
    enabled: () => false,
    registry: { list: () => [], get: () => undefined },
    deps: { log: () => undefined },
  })
  const state = contexts.pinned()!.stateManager()
  await state.load()
  const owner = new HostCapture()
  owner.contexts(contexts)
  const entered = Promise.withResolvers<ReturnType<typeof native>>()
  const route = { value: 0 }
  const event = { properties: { mode: "worktree", requestID: "real-tool", tasks: [{ name: "capture fixture" }] } }
  const action = handleToolEvent(
    event,
    root,
    {
      byDirectory: () => {
        route.value++
        return { id: "private" }
      },
      usable: () => undefined,
    },
    { run: async (_ctx, body) => body() },
    async (req) => {
      assert.equal(req.projectId, "private")
      const created = await createWorktreeOnDisk(
        {
          getWorktreeManager: () => manager,
          getStateManager: () => state,
          postToWebview: () => undefined,
          capture: () => undefined,
          pushState: () => undefined,
          log: () => undefined,
          failure: (err) => owner.observe(err),
        },
        { branchName: "raya-capture-test" },
      )
      assert.ok(created)
      const proc = native("git", ["-C", created.result.path, "hash-object", "--stdin", "-w"], root)
      await proc.ready
      entered.resolve(proc)
      assert.equal(await proc.done, 0)
      state.addSession("accepted-tool", created.worktree.id)
      await registerWorktreeSession("accepted-tool", created.result.path, {
        worktree: created.worktree,
        manager,
        failure: (err) => owner.observe(err),
        log: () => undefined,
      })
    },
    (body) => owner.run(body),
  )!
  assert.equal(route.value, 0)
  const proc = await entered.promise
  const capture = owner.capture(client(), Date.now() + 15_000)
  const closed = { value: false }
  const observed = capture.then(
    () => {
      closed.value = true
    },
    () => {
      closed.value = true
    },
  )
  try {
    await expect(
      handleToolEvent(
        event,
        root,
        {
          byDirectory: () => {
            throw new Error("late routing must not run")
          },
          usable: () => undefined,
        },
        { run: async (_ctx, body) => body() },
        async () => {
          throw new Error("late body")
        },
        (body) => owner.run(body),
      )!,
    ).rejects.toThrow("retired")
    await Bun.sleep(60)
    expect(closed.value).toBe(false)
    expect(proc.child.exitCode).toBeNull()
    proc.child.stdin.end("Native accepted tool café 日本語 😀\n")
    await action
    await capture
    const rows = JSON.parse(await readFile(path.join(root, ".kilo", "agent-manager.json"), "utf8"))
    expect(rows.sessions["accepted-tool"]).toBeDefined()
    const list = await git(root, ["worktree", "list", "--porcelain"])
    expect(list).toContain("raya-capture-test")
    const wt = state.getWorktree(rows.sessions["accepted-tool"].worktreeId)
    assert.ok(wt)
    expect((await manager.readMetadata(wt.path))?.sessionId).toBe("accepted-tool")
    assert.throws(() => process.kill(proc.child.pid!, 0))
  } finally {
    proc.child.stdin.end()
    await Promise.allSettled([action, observed, proc.done])
  }
}, 30_000)

test("native worktree failure stays sticky after existing null/UI conversion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-host-tool-refused-"))
  const state = new WorktreeStateManager(root, () => undefined)
  await state.load()
  const manager = new WorktreeManager(root, () => undefined)
  const owner = new HostCapture()
  const result = await owner.run(() =>
    createWorktreeOnDisk(
      {
        getWorktreeManager: () => manager,
        getStateManager: () => state,
        postToWebview: () => undefined,
        capture: () => undefined,
        pushState: () => undefined,
        log: () => undefined,
        failure: (err) => owner.observe(err),
      },
      { branchName: "cannot-create" },
    ),
  )
  expect(result).toBeNull()
  await expect(owner.capture(client(), Date.now() + 10_000)).rejects.toThrow("capture preparation failed")
  expect(
    handleToolEvent(
      {},
      undefined,
      { byDirectory: () => undefined, usable: () => undefined },
      { run: async (_ctx, body) => body() },
      async () => undefined,
      (body) => owner.run(body),
    ),
  ).toBeUndefined()
})

test("actual configured native setup failure retains capture refusal while ordinary setup remains best effort", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-host-setup-"))
  await mkdir(path.join(root, ".kilo"))
  await writeFile(
    path.join(root, ".kilo", process.platform === "win32" ? "setup-script.ps1" : "setup-script"),
    process.platform === "win32" ? "exit 7\n" : "exit 7\n",
  )
  const owner = new HostCapture()
  const runner = new SetupScriptRunner(
    () => undefined,
    new SetupScriptService(root),
    async (cfg) => {
      const proc = native(cfg.command, cfg.args, cfg.cwd, { ...process.env, ...cfg.env, HOME: root, USERPROFILE: root })
      await proc.ready
      proc.child.stdin.end()
      const code = await proc.done
      assert.throws(() => process.kill(proc.child.pid!, 0))
      return code ?? undefined
    },
    () => undefined,
    (err) => owner.observe(err),
  )
  expect(await owner.run(() => runner.runIfConfigured({ worktreePath: root, repoPath: root }))).toBe(true)
  await expect(owner.capture(client(), Date.now() + 10_000)).rejects.toThrow("capture preparation failed")
})

test("tool task keeps raw actual filesystem failure before converting it into progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-host-tool-io-"))
  const owner = new HostCapture()
  const state = new WorktreeStateManager(root, () => undefined)
  await state.load()
  const errors: unknown[] = []
  await owner.run(() =>
    startFromTool(
      {
        getClient: client,
        getRoot: () => root,
        getState: () => state,
        getPanel: () => undefined,
        openPanel: () => undefined,
        waitReady: () => state.load(),
        createWorktree: async () => {
          await readFile(path.join(root, "missing-native-input"))
          throw new Error("missing input must refuse before creation")
        },
        cleanupWorktree: () => state.flush(),
        setup: () => state.flush(),
        createSessionInWorktree: async () => null,
        sessionMetadata: async () => ({}),
        registerWorktreeSession: () => undefined,
        notifyReady: () => undefined,
        push: () => undefined,
        post: () => undefined,
        capture: () => undefined,
        log: () => undefined,
        error: () => undefined,
        failure: (err) => {
          errors.push(err)
          owner.observe(err)
        },
      },
      { requestID: "native-failure", mode: "worktree", tasks: [{ name: "private" }] },
    ),
  )
  expect(errors).toHaveLength(1)
  expect((errors[0] as NodeJS.ErrnoException).code).toBe("ENOENT")
  const result = await owner.capture(client(), Date.now() + 10_000).catch((err: unknown) => err)
  assert.ok(result instanceof AggregateError)
  expect(result.errors).toContain(errors[0])
})

test("actual setup environment publication failure is retained without poisoning expected existing-file skips", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-host-env-"))
  await writeFile(path.join(root, ".env"), "PRIVATE_FIXTURE=nonsecret\n")
  const owner = new HostCapture()
  expect(
    await owner.run(() =>
      copyEnvFiles(
        root,
        root,
        () => undefined,
        (err) => owner.observe(err),
      ),
    ),
  ).toEqual({
    copied: [],
    skipped: [".env"],
  })
  await owner.capture(client(), Date.now() + 10_000)
  const failed = new HostCapture()
  expect(
    await failed.run(() =>
      copyEnvFiles(
        root,
        path.join(root, "missing"),
        () => undefined,
        (err) => failed.observe(err),
      ),
    ),
  ).toEqual({
    copied: [],
    skipped: [],
  })
  await expect(failed.capture(client(), Date.now() + 10_000)).rejects.toThrow("capture preparation failed")
})
