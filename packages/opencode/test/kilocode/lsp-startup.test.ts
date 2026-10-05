import { expect, test } from "bun:test"
import { Effect, Exit, Fiber, Scope } from "effect"
import { spawn } from "node:child_process"
import path from "node:path"
import { startups } from "../../src/kilocode/lsp-startup"
import { LSPClient } from "../../src/lsp/client"
import { Process } from "../../src/util/process"
import { tmpdir, withTestInstance } from "../fixture/fixture"
import { withTimeout } from "../../src/util/timeout"

const bun = process.execPath
function absent(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") return true
    throw err
  }
}

test("canceled scoped LSP startup remains owned through held loopback install, real client registration and child exit", async () => {
  await using dir = await tmpdir()
  const owner = startups()
  const clients: LSPClient.Info[] = []
  const children: ReturnType<typeof spawn>[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const source = await Bun.file(path.join(import.meta.dir, "../fixture/lsp/fake-lsp-server.js")).text()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      entered.resolve()
      await release.promise
      return new Response(source)
    },
  })
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(
    Scope.addFinalizer(
      scope,
      Effect.promise(() => owner.close(() => clients.map((client) => () => client.shutdown()))),
    ),
  )
  const file = path.join(dir.path, "installed-lsp.js")
  const fiber = Effect.runFork(
    Effect.promise(() =>
      owner.run(async () => {
        const response = await fetch(server.url)
        await Bun.write(file, await response.text())
        const child = spawn(bun, [file], { stdio: "pipe", windowsHide: true })
        children.push(child)
        const client = await withTestInstance({
          directory: dir.path,
          fn: (ctx) =>
            LSPClient.create({
              serverID: "real-startup",
              server: { process: child },
              root: dir.path,
              directory: dir.path,
              instance: ctx,
            }),
        })
        clients.push(client)
      }),
    ),
  )
  try {
    await withTimeout(entered.promise, 2_000, "loopback install did not begin")
    await Effect.runPromise(Fiber.interrupt(fiber))
    let settled = false
    const closed = Effect.runPromise(Scope.close(scope, Exit.void)).finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(() => owner.run(async () => undefined)).toThrow("intake is closing")
    release.resolve()
    await withTimeout(closed, 5_000, "owned startup did not retire")
    expect(clients).toHaveLength(1)
    expect(children).toHaveLength(1)
    expect(absent(children[0].pid!)).toBe(true)
    expect(await Bun.file(file).exists()).toBe(true)
  } finally {
    release.resolve()
    await Promise.allSettled(children.map((child) => Process.stop(child)))
    await server.stop(true)
  }
}, 10_000)

test("synchronous startup reservation joins concurrent callers and retains recovered raw failure while closing every real child", async () => {
  const owner = startups()
  const children = [
    spawn(bun, ["-e", "setInterval(()=>{},1000)"], { stdio: "pipe", windowsHide: true }),
    spawn(bun, ["-e", "setInterval(()=>{},1000)"], { stdio: "pipe", windowsHide: true }),
  ]
  const failure = new Error("raw installer failure was logged and recovered")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const task = owner.run(async () => {
    entered.resolve()
    await release.promise
    owner.fail(failure)
  })
  const stops = () => children.map((child) => () => Process.stop(child))
  const closed = owner.close(stops)
  const result = closed.catch((err: unknown) => err)
  expect(owner.close(() => [])).toBe(closed)
  expect(() => owner.run(async () => undefined)).toThrow("intake is closing")
  try {
    await entered.promise
    expect(children.every((child) => !absent(child.pid!))).toBe(true)
    release.resolve()
    await task
    const err = await withTimeout(result, 5_000)
    expect(err).toBeInstanceOf(AggregateError)
    if (!(err instanceof AggregateError)) throw err
    expect(err.errors).toContain(failure)
    expect(children.every((child) => absent(child.pid!))).toBe(true)
    expect(await owner.close(stops).catch((err: unknown) => err)).toBe(err)
  } finally {
    release.resolve()
    await Promise.allSettled(children.map((child) => Process.stop(child)))
  }
}, 10_000)
