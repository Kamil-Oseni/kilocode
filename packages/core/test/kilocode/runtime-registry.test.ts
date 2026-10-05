import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { createRegistry } from "../../src/kilocode/runtime-registry"

test("retirement invokes all fences synchronously, joins held work and retains every failure", async () => {
  const registry = createRegistry()
  const held = Promise.withResolvers<void>()
  const first = new Error("synchronous refusal")
  const second = new Error("asynchronous refusal")
  const calls: number[] = []
  let joined: Promise<void> | undefined
  registry.register(() => {
    calls.push(1)
    joined = registry.drain()
    throw first
  })
  registry.register(() => {
    calls.push(2)
    return held.promise
  })
  registry.register(() => {
    calls.push(3)
    return Promise.reject(second)
  })
  const closed = registry.drain()
  expect(calls).toEqual([1, 2, 3])
  expect(joined).toBe(closed)
  expect(registry.drain()).toBe(closed)
  expect(() => registry.check()).toThrow("registration is closed")
  expect(() => registry.register(() => Promise.resolve())).toThrow("registration is closed")
  let settled = false
  const failure = closed.catch((err: unknown) => {
    settled = true
    return err
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  held.resolve()
  const err = await failure
  expect(err).toBeInstanceOf(AggregateError)
  if (!(err instanceof AggregateError)) throw err
  expect(err.errors).toEqual([first, second])
  expect(registry.drain()).toBe(closed)
  expect(await registry.drain().catch((err: unknown) => err)).toBe(err)
  expect(calls).toEqual([1, 2, 3])
})

test("empty successful retirement is terminal and joinable", async () => {
  const registry = createRegistry()
  registry.check()
  const closed = registry.drain()
  await closed
  expect(registry.drain()).toBe(closed)
  expect(() => registry.check()).toThrow("registration is closed")
  expect(() => registry.register(() => Promise.resolve())).toThrow("registration is closed")
})

test("production registry retires real Core scopes and SQLite in an isolated process", async () => {
  const child = Bun.spawn([process.execPath, "test", "./test/kilocode/runtime-registry.fixture.ts"], {
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timer = setTimeout(() => child.kill(), 30_000)
  try {
    const code = await child.exited
    const [stdout, stderr] = await output
    expect(code, stdout + stderr).toBe(0)
    expect(stdout + stderr).toContain("1 pass")
    expect(stdout + stderr).toContain("0 fail")
    const absent = (() => {
      try {
        process.kill(child.pid, 0)
        return false
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") return true
        throw err
      }
    })()
    expect(absent).toBe(true)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
    await output
  }
}, 40_000)
