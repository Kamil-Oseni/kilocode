import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createStream } from "rotating-file-stream"
import { createOwner } from "../../src/kilocode/log-owner"
import { tmpdir } from "../fixture/tmpdir"

test("real rotating stream persists the final accepted marker and closes once", async () => {
  await using tmp = await tmpdir()
  const owner = createOwner()
  const stream = createStream("active.log", { path: tmp.path })
  owner.own(stream)
  const marker = crypto.randomUUID()
  owner.write(stream, "x".repeat(1024 * 1024) + marker, () => {
    throw new Error("Unexpected fallback")
  })
  const first = owner.drain()
  expect(owner.drain()).toBe(first)
  await first
  expect(stream.closed).toBe(true)
  expect((await fs.readFile(path.join(tmp.path, "active.log"), "utf8")).endsWith(marker)).toBe(true)
  const before = await fs.readFile(path.join(tmp.path, "active.log"), "utf8")
  expect(owner.write(stream, "late", (msg) => msg.length)).toBe(4)
  expect(await fs.readFile(path.join(tmp.path, "active.log"), "utf8")).toBe(before)
  expect(await owner.run(async () => undefined).catch((err: unknown) => err)).toMatchObject({
    message: "Legacy logger admission is closed",
  })
})

test("native stream open failure remains sticky while other streams close", async () => {
  await using tmp = await tmpdir()
  await fs.writeFile(path.join(tmp.path, "block"), "not a directory")
  const owner = createOwner()
  const bad = createStream("bad.log", { path: path.join(tmp.path, "block") })
  const good = createStream("good.log", { path: tmp.path })
  owner.own(bad)
  owner.own(good)
  owner.write(bad, "failed", (msg) => msg.length)
  owner.write(good, "final", (msg) => msg.length)
  const first = owner.drain()
  const err = await first.catch((err: unknown) => err)
  expect(err).toBeInstanceOf(AggregateError)
  if (!(err instanceof AggregateError)) throw new Error("Missing native stream failure")
  expect(
    err.errors.some((err) => err instanceof Error && "code" in err && ["ENOTDIR", "EEXIST"].includes(String(err.code))),
  ).toBe(true)
  expect(good.closed).toBe(true)
  expect(await fs.readFile(path.join(tmp.path, "good.log"), "utf8")).toBe("final")
  expect(owner.drain()).toBe(first)
  expect(await owner.drain().catch((err: unknown) => err)).toBe(err)
})

test("drain joins actual held download initialization before closing its stream", async () => {
  await using tmp = await tmpdir()
  const owner = createOwner()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    async fetch() {
      entered.resolve()
      await release.promise
      return new Response("accepted final marker")
    },
  })
  try {
    const task = owner.run(async (permit) => {
      const text = await (await fetch(server.url)).text()
      const stream = createStream("held.log", { path: tmp.path })
      owner.own(stream, permit)
      stream.write(text)
      return stream
    })
    await entered.promise
    const closing = owner.drain()
    let settled = false
    void closing.then(() => {
      settled = true
    })
    await Bun.sleep(20)
    expect(settled).toBe(false)
    expect(await fs.readdir(tmp.path)).toEqual([])
    release.resolve()
    const stream = await task
    await closing
    expect(stream.closed).toBe(true)
    expect(await fs.readFile(path.join(tmp.path, "held.log"), "utf8")).toBe("accepted final marker")
  } finally {
    release.resolve()
    await server.stop(true)
  }
})

test("unused terminal owner does no filesystem work", async () => {
  await using tmp = await tmpdir()
  const before = await fs.stat(tmp.path)
  const owner = createOwner()
  await owner.drain()
  await owner.drain()
  expect(await fs.readdir(tmp.path)).toEqual([])
  expect((await fs.stat(tmp.path)).mtimeMs).toBe(before.mtimeMs)
})

test("real rotation history warning refuses retirement while retaining its raw cause", async () => {
  await using tmp = await tmpdir()
  const dir = path.join(tmp.path, "not-file")
  await fs.mkdir(dir)
  await fs.writeFile(path.join(tmp.path, ".log-history"), dir + "\n")
  const owner = createOwner()
  const stream = createStream("rotate.log", { path: tmp.path, size: "1B", maxFiles: 1, history: ".log-history" })
  owner.own(stream)
  const warning = Promise.withResolvers<Error>()
  stream.once("warning", warning.resolve)
  owner.write(stream, "rotate now", (msg) => msg.length)
  const first = owner.drain()
  const err = await first.catch((err: unknown) => err)
  const raw = await warning.promise
  expect(raw.message).toContain("not a regular file")
  if (!(err instanceof AggregateError)) throw new Error("Missing rotation uncertainty")
  expect(err.errors).toContain(raw)
  expect(stream.closed).toBe(true)
  expect(owner.drain()).toBe(first)
})
