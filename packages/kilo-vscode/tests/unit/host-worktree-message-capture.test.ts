import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { HostCapture } from "../../src/kilo-provider/host-capture"
import { ProjectContexts } from "../../src/agent-manager/project/contexts"
import { ProjectScope } from "../../src/agent-manager/project/scope"
import { admitWorktreeMessage } from "../../src/agent-manager/worktree-admission"
import { contextMessage } from "../../src/agent-manager/message-context"
import { deleteLifecycleWorktree, type LifecycleHost } from "../../src/agent-manager/provider-lifecycle"
import { WorktreeManager } from "../../src/agent-manager/WorktreeManager"

const client = () => createKiloClient({ baseUrl: "http://127.0.0.1:1" })
function native(root: string, args: string[]) {
  const proc = spawn("git", ["-c", "core.hooksPath=", "-C", root, ...args], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  proc.stdout.resume()
  proc.stderr.resume()
  const ready = new Promise<void>((resolve, reject) => {
    proc.once("spawn", resolve)
    proc.once("error", reject)
  })
  const done = new Promise<number | null>((resolve, reject) => {
    proc.once("close", resolve)
    proc.once("error", reject)
  })
  return { proc, ready, done }
}
async function git(root: string, args: string[]) {
  const child = native(root, args)
  await child.ready
  child.proc.stdin.end()
  assert.equal(await child.done, 0)
}
async function scene() {
  const root = await mkdtemp(path.join(tmpdir(), "raya-host-worktree-message-"))
  await git(root, ["init", "--quiet", "--template="])
  await writeFile(path.join(root, "file.txt"), "fixture\n")
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
  const contexts = new ProjectContexts({
    workspaceRoot: () => root,
    enabled: () => false,
    registry: { list: () => [], get: () => undefined },
    deps: { log: () => undefined },
  })
  const ctx = contexts.pinned()!
  const state = ctx.stateManager()
  await state.load()
  const manager = ctx.worktreeManager()
  const created = await manager.createWorktree({ branchName: "raya-message-test", prompt: "fixture" })
  const wt = state.addWorktree(created)
  state.addSession("real-session", wt.id)
  await state.flush()
  const owner = new HostCapture()
  owner.contexts(contexts)
  const host: LifecycleHost = {
    createOnDisk: async () => null,
    runSetup: async () => undefined,
    createSession: async () => null,
    notifyReady: () => undefined,
    sessions: {
      register: () => undefined,
      clearDirectory: () => undefined,
      directories: () => undefined,
      abort: async () => undefined,
      forget: () => undefined,
    },
    push: () => undefined,
    register: () => undefined,
    skipStats: () => undefined,
    unskipStats: () => undefined,
    removePR: () => undefined,
    removeRun: async () => undefined,
    clearRun: async () => true,
    forgetName: () => undefined,
    stopDiffs: () => undefined,
    capture: () => undefined,
    autoName: () => ({ enabled: false }),
    client,
    acquirePtyCleanup: async () => () => undefined,
    metadata: async () => ({}),
    post: () => undefined,
    log: () => undefined,
    failure: (err) => owner.observe(err),
  }
  return { root, contexts, ctx, state, manager, created, wt, owner, host }
}

test("accepted webview deletion survives cutoff, joins held native phase and all real filesystem cleanup", async () => {
  const value = await scene()
  const scope = new ProjectScope()
  const entered = Promise.withResolvers<ReturnType<typeof native>>()
  value.host.clearRun = async () => {
    const child = native(value.created.path, ["hash-object", "--stdin", "-w"])
    await child.ready
    entered.resolve(child)
    return (await child.done) === 0
  }
  await writeFile(path.join(value.created.path, "dirty.txt"), "current uncommitted bytes\n")
  await mkdir(path.join(value.created.path, "nested"))
  await writeFile(path.join(value.created.path, "nested", "bytes.bin"), Buffer.alloc(128_000, 7))
  const routes = { value: 0 }
  const msg = { type: "agentManager.deleteWorktree", worktreeId: value.wt.id }
  const action = admitWorktreeMessage(
    msg,
    () => {
      routes.value++
      return scope.run(value.ctx, async () => {
        assert.equal(scope.current(), value.ctx)
        await deleteLifecycleWorktree(value.ctx, value.host, value.wt.id)
        assert.equal(scope.current(), value.ctx)
      })
    },
    (body) => value.owner.run(body),
  )
  assert.equal(routes.value, 0)
  // Cutoff precedes the accepted body's first instruction and must not revoke it.
  const closing = value.owner.capture(client(), Date.now() + 15_000)
  const closed = { value: false }
  const observed = closing.then(
    () => {
      closed.value = true
    },
    () => {
      closed.value = true
    },
  )
  const child = await entered.promise
  try {
    await expect(
      admitWorktreeMessage(
        msg,
        async () => {
          throw new Error("late route")
        },
        (body) => value.owner.run(body),
      ),
    ).rejects.toThrow("retired")
    await Bun.sleep(60)
    expect(closed.value).toBe(false)
    expect(child.proc.exitCode).toBeNull()
    child.proc.stdin.end("accepted native removal phase\n")
    await action
    await closing
    expect(
      (await readdir(path.join(value.root, ".kilo", "worktrees"))).filter((file) => file.startsWith(".kilo-delete-")),
    ).toEqual([])
    await expect(readFile(path.join(value.created.path, "dirty.txt"))).rejects.toThrow()
    const data = JSON.parse(await readFile(path.join(value.root, ".kilo", "agent-manager.json"), "utf8"))
    expect(data.worktrees[value.wt.id]).toBeUndefined()
    assert.throws(() => process.kill(child.proc.pid!, 0))
  } finally {
    child.proc.stdin.end()
    await Promise.allSettled([action, closing, observed, child.done])
  }
}, 30_000)

test("actual branch lock failure stays sticky after deletion conversion while renamed bytes are fully removed", async () => {
  const value = await scene()
  await writeFile(
    path.join(value.root, ".git", "refs", "heads", `${value.created.branch}.lock`),
    "owned fixture lock\n",
  )
  await admitWorktreeMessage(
    { type: "agentManager.deleteWorktree" },
    () => deleteLifecycleWorktree(value.ctx, value.host, value.wt.id),
    (body) => value.owner.run(body),
  )
  expect(
    (await readdir(path.join(value.root, ".kilo", "worktrees"))).filter((file) => file.startsWith(".kilo-delete-")),
  ).toEqual([])
  await expect(value.owner.capture(client(), Date.now() + 15_000)).rejects.toThrow("capture preparation failed")
})

test("orphan discovery joins actual deletions and read-only context enrichment preserves existing routing", async () => {
  const value = await scene()
  const orphan = path.join(value.root, ".kilo", "worktrees", ".kilo-delete-retained")
  await mkdir(orphan)
  await writeFile(path.join(orphan, "receipt.txt"), "no detached deletion\n")
  await value.manager.discoverWorktrees()
  await expect(readFile(path.join(orphan, "receipt.txt"))).rejects.toThrow()
  const read = await contextMessage(
    { type: "requestGitChangesContext" },
    {
      target: async () => undefined,
      active: () => "real-session",
      state: () => value.state,
    },
  )
  expect(read).toMatchObject({ sessionID: "real-session", contextDirectory: value.created.path })
  const raw = { type: "requestState" }
  expect(
    await admitWorktreeMessage(
      raw,
      async () => raw,
      () => {
        throw new Error("read-only admission must not change")
      },
    ),
  ).toBe(raw)
  await value.owner.capture(client(), Date.now() + 15_000)
})

test("unexpected native orphan enumeration failure remains a refusal rather than empty cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-host-orphan-refused-"))
  await mkdir(path.join(root, ".kilo"))
  await writeFile(path.join(root, ".kilo", "worktrees"), "not a directory\n")
  const manager = new WorktreeManager(root, () => undefined)
  const owner = new HostCapture()
  await expect(owner.run(() => manager.cleanupOrphanedTempDirs())).rejects.toThrow()
  await expect(owner.capture(client(), Date.now() + 10_000)).rejects.toThrow("capture preparation failed")
  expect(await readFile(path.join(root, ".kilo", "worktrees"), "utf8")).toBe("not a directory\n")
})
