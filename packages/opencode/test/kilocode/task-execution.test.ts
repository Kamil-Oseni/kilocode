import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const fixture = path.join(import.meta.dir, "fixtures", "task-execution.ts")
const runner = path.join(import.meta.dir, "fixtures", "task-execution-runner.ts")
const procs: ReturnType<typeof Bun.spawn>[] = []
const logs = new Map<number, Promise<string>>()

async function diagnostic(child: ReturnType<typeof Bun.spawn>) {
  return (await logs.get(child.pid)?.catch((err) => String(err)))?.trim() || "no stderr"
}

async function wait(file: string, value: string | undefined, child?: ReturnType<typeof Bun.spawn>) {
  const end = Date.now() + 60_000
  while (Date.now() < end) {
    const text = await Bun.file(file)
      .text()
      .catch(() => "")
    if (value === undefined ? text.length > 0 : text === value) return
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error(
        `Fixture ${child.pid} exited ${child.exitCode} with ${text || "no receipt"}: ${await diagnostic(child)}`,
      )
    await Bun.sleep(20)
  }
  const trace = await Bun.file(`${file}.trace`)
    .text()
    .catch(() => "no continuation")
  const revived = await Bun.file(`${file}.revived`)
    .text()
    .catch(() => "not revived")
  const state = await Bun.file(`${file}.state`)
    .text()
    .catch(() => "no state")
  throw new Error(`Timed out waiting for ${value ?? "a receipt"}: ${trace}; ${revived}; ${state}`)
}

function launch(dir: string, file: string, mode: "hold" | "once" | "seed", script = fixture) {
  const root = path.dirname(dir)
  const child = Bun.spawn([process.execPath, script, dir, file, mode], {
    cwd: path.join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      KILO_TEST_HOME: path.join(root, "home"),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  procs.push(child)
  logs.set(child.pid, new Response(child.stderr).text())
  return child
}

async function joined(child: ReturnType<typeof Bun.spawn>, timeout = 15_000) {
  return await Promise.race([
    child.exited,
    Bun.sleep(timeout).then(() => {
      throw new Error(`Fixture ${child.pid} did not exit within ${timeout}ms`)
    }),
  ])
}

async function stop(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode === null) child.kill(9)
  return await joined(child)
}

async function cleanup() {
  const children = [...procs]
  const results = await Promise.allSettled(children.map(stop))
  const failed = results.flatMap((result, index) => {
    const child = children[index]
    if (result.status === "rejected") return [{ child, reason: result.reason }]
    const offset = procs.indexOf(child)
    if (offset >= 0) procs.splice(offset, 1)
    logs.delete(child.pid)
    return []
  })
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      `Fixture cleanup was not confirmed for ${failed.map((result) => result.child.pid).join(", ")}`,
    )
}

afterEach(cleanup)

test("a live backend exclusively owns continuing routine execution and a stopped owner permits takeover", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-task-execution-"))
  try {
    const storage = path.join(root, "storage")
    const first = path.join(root, "first")
    const denied = path.join(root, "denied")
    const resumed = path.join(root, "resumed")
    const owner = launch(storage, first, "hold")
    await wait(first, "owned", owner)

    const contender = launch(storage, denied, "once")
    await wait(denied, "denied", contender)
    expect(await joined(contender)).toBe(10)
    expect(await Bun.file(denied).text()).toBe("denied")
    expect(owner.exitCode).toBeNull()

    expect(await stop(owner)).not.toBe(0)
    const successor = launch(storage, resumed, "once")
    await wait(resumed, "taken-over", successor)
    expect(await joined(successor)).toBe(0)
    expect(await Bun.file(resumed).text()).toBe("taken-over")
  } finally {
    await cleanup()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 120_000)

test("runner revival fences the real goal continuation and never replays an interrupted dispatch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-task-execution-runner-"))
  try {
    const storage = path.join(root, "storage")
    const seeded = path.join(root, "seeded")
    const seed = launch(storage, seeded, "seed", runner)
    await wait(seeded, "seeded", seed)
    expect(await joined(seed)).toBe(0)
    expect(await Bun.file(seeded).text()).toBe("seeded")

    const first = path.join(root, "first")
    const owner = launch(storage, first, "hold", runner)
    await wait(first, "entered", owner)
    const dispatch = JSON.parse(await Bun.file(`${first}.dispatch`).text()) as Record<string, unknown>
    const denied = path.join(root, "denied")
    const contender = launch(storage, denied, "once", runner)
    await wait(denied, "denied", contender)
    expect(await joined(contender)).toBe(10)
    expect(await Bun.file(denied).text()).toBe("denied")

    expect(await stop(owner)).not.toBe(0)
    const resumed = path.join(root, "resumed")
    const successor = launch(storage, resumed, "once", runner)
    await wait(resumed, undefined, successor)
    expect(await joined(successor)).toBe(0)
    expect(JSON.parse(await Bun.file(resumed).text())).toEqual({ state: "no-replay", ...dispatch })
  } finally {
    await cleanup()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 150_000)
