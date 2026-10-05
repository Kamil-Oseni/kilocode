import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { HostCapture, hostPayload } from "../../src/kilo-provider/host-capture"
import { ProjectContexts } from "../../src/agent-manager/project/contexts"
import { apply } from "../../src/agent-manager/git-transfer"

const client = () => createKiloClient({ baseUrl: "http://127.0.0.1:1" })
async function git(root: string, args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  )
  const child = spawn("git", ["-c", "core.hooksPath=", "-C", root, ...args], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on("data", (data: Buffer) => stdout.push(data))
  child.stderr.on("data", (data: Buffer) => stderr.push(data))
  const ready = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve)
    child.once("error", reject)
  })
  await ready
  return {
    child,
    done,
    output: () => Buffer.concat(stdout).toString().trim(),
    error: () => Buffer.concat(stderr).toString(),
  }
}

test("capture joins accepted actual native Git and state publication; later continuations refuse", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-host-continuation-"))
  const init = await git(root, ["init", "--quiet", "--template="])
  init.child.stdin.end()
  assert.equal(await init.done, 0)
  const contexts = new ProjectContexts({
    workspaceRoot: () => root,
    enabled: () => false,
    registry: { list: () => [], get: () => undefined },
    deps: { log: () => undefined },
  })
  const state = contexts.pinned()!.stateManager()
  const owner = new HostCapture()
  owner.contexts(contexts)
  const entered = Promise.withResolvers<Awaited<ReturnType<typeof git>>>()
  const bytes = "Actual held Git continuation café 日本語 😀\n"
  const action = owner.run(async () => {
    const proc = await git(root, ["hash-object", "--stdin", "-w"])
    entered.resolve(proc)
    const code = await proc.done
    assert.equal(code, 0, proc.error())
    state.addSession("accepted-native", null)
    await state.flush()
    return proc.output()
  })
  const proc = await entered.promise
  const capture = owner.capture(client(), Date.now() + 10_000)
  const settled = { value: false }
  const observed = capture.then(
    () => {
      settled.value = true
    },
    () => {
      settled.value = true
    },
  )
  try {
    await expect(
      owner.run(async () => {
        throw new Error("late body must not execute")
      }),
    ).rejects.toThrow("retired")
    expect(() => owner.message({ type: "continueInWorktree" })).toThrow("retired")
    await Bun.sleep(60) // Observe real native stdin holding the accepted body, not startup readiness.
    expect(settled.value).toBe(false)
    expect(proc.child.exitCode).toBeNull()
    proc.child.stdin.end(bytes)
    const hash = await action
    const token = await capture
    expect(hostPayload(token).hosts).toHaveLength(1)
    const file = JSON.parse(await readFile(path.join(root, ".kilo", "agent-manager.json"), "utf8"))
    expect(file.sessions["accepted-native"]).toBeDefined()
    const verify = await git(root, ["cat-file", "blob", hash])
    verify.child.stdin.end()
    assert.equal(await verify.done, 0)
    expect(verify.output()).toBe(bytes.trim())
    assert.throws(() => process.kill(proc.child.pid!, 0))
    expect(owner.capture(client(), Date.now() + 10_000)).toBe(capture)
    await writeFile(
      path.join(root, "receipt.json"),
      JSON.stringify({
        passed: true,
        nativePid: proc.child.pid,
        nativeExitCode: proc.child.exitCode,
        captureRetired: true,
        completeProfileCoverage: false,
      }),
    )
  } finally {
    proc.child.stdin.end()
    await Promise.allSettled([action, capture, observed, proc.done, state.retire()])
  }
}, 30_000)

test("raw native continuation failure remains sticky after caller handles it and closes real owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-host-continuation-failure-"))
  const contexts = new ProjectContexts({
    workspaceRoot: () => root,
    enabled: () => false,
    registry: { list: () => [], get: () => undefined },
    deps: { log: () => undefined },
  })
  const state = contexts.pinned()!.stateManager()
  state.addSession("retired-on-failure", null)
  const owner = new HostCapture()
  owner.contexts(contexts)
  const error = new Error("Actual Git continuation failed")
  await owner
    .run(async () => {
      const proc = await git(root, ["hash-object", "--stdin", "-w"])
      proc.child.stdin.end("private unsuccessful input")
      assert.notEqual(await proc.done, 0)
      assert.throws(() => process.kill(proc.child.pid!, 0))
      throw error
    })
    .catch((failure) => {
      assert.equal(failure, error)
    })
  const capture = owner.capture(client(), Date.now() + 10_000)
  const failure = await capture.catch((err) => err)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toContain(error)
  expect(owner.capture(client(), Date.now() + 10_000)).toBe(capture)
  expect(() => state.addSession("late", null)).toThrow("retired")
  expect(
    JSON.parse(await readFile(path.join(root, ".kilo", "agent-manager.json"), "utf8")).sessions["retired-on-failure"],
  ).toBeDefined()
  expect(() => hostPayload({ generation: "forged" })).toThrow("not owned")
}, 30_000)

test("actual converted Git and file-write failures still refuse host capture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-host-converted-continuation-"))
  const init = await git(root, ["init", "--quiet", "--template="])
  init.child.stdin.end()
  assert.equal(await init.done, 0)
  const owner = new HostCapture()
  const result = await owner.run(() =>
    apply(
      { branch: "private", head: "", staged: "invalid native patch\n", unstaged: null, untracked: [] },
      root,
      () => undefined,
      (err) => owner.observe(err),
    ),
  )
  expect(result.ok).toBe(false)
  await expect(owner.capture(client(), Date.now() + 5000)).rejects.toBeInstanceOf(AggregateError)

  await writeFile(path.join(root, "blocked"), "Actual regular file blocks the directory creation")
  const publication = new HostCapture()
  const returned = await publication.run(() =>
    apply(
      {
        branch: "private",
        head: "",
        staged: null,
        unstaged: null,
        untracked: [{ path: "blocked/file", content: Buffer.from("must not silently succeed for capture") }],
      },
      root,
      () => undefined,
      (err) => publication.observe(err),
    ),
  )
  expect(returned.ok).toBe(true) // Existing UI conversion remains compatible; retirement retains the raw IO failure.
  const failure = await publication.capture(client(), Date.now() + 5000).catch((err) => err)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors.some((err: unknown) => err instanceof Error && "code" in err)).toBe(true)
}, 30_000)
