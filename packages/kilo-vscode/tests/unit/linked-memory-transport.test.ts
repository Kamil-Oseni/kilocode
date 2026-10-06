import { expect, test } from "bun:test"
import path from "node:path"
import { ClientV2 } from "../../src/second-brain/client-v2"
import { parse } from "../../src/second-brain/operation"

const python = process.env.RAYA_LINKED_TEST_PYTHON
const genuine = python ? test : test.skip

genuine("real Python reader and Journal result traverse the original client with explicit budget", async () => {
  const child = Bun.spawn(
    [
      python!,
      "-I",
      "-S",
      "-B",
      path.join(import.meta.dir, "fixtures/linked-memory-producer.py"),
      path.join(import.meta.dir, "../../script/memory/service"),
    ],
    { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code).toBe(0)
  expect(stderr).toBe("")
  const fixture = JSON.parse(stdout)
  const bytes = Buffer.from(fixture.response, "base64")
  expect(parse(bytes, fixture.selected, "response").result).toBeDefined()
  expect(() => parse(bytes, { ...fixture.selected, budget: undefined }, "response")).toThrow()
  const changed = bytes.toString().replace('"heading":"Eden"', '"heading":"Other"')
  expect(changed).not.toBe(bytes.toString())
  expect(() => parse(Buffer.from(changed), fixture.selected, "response")).toThrow()
  const posts: unknown[] = []
  const before: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== "Bearer private-fixture") return new Response(null, { status: 401 })
      if (new URL(request.url).pathname === "/health")
        return Response.json({
          protocol: "raya.memory.operation.v1",
          operation_protocol: "raya.memory.operation.v1",
          owner_epoch: fixture.selected.epoch,
          selected_release_sha256: fixture.selected.release,
          root: fixture.root,
          source_sha256: fixture.pins,
          active: 0,
          admission_required: true,
          capture_enabled: false,
          namespace_valid: true,
          ready: true,
          draining: false,
          retirement_pending: false,
          retirement_unconfirmed: false,
        })
      expect(before.length).toBe(1)
      expect(request.headers.get("x-raya-memory-owner-epoch")).toBe(fixture.selected.epoch)
      posts.push(await request.json())
      return new Response(bytes, { headers: { "Content-Type": "application/json" } })
    },
  })
  try {
    const setup = {
      format: "raya.memory.setup",
      version: 2,
      protocol: "raya.memory.operation.v1",
      origin: `http://127.0.0.1:${server.port}`,
      root: fixture.root,
      source_sha256: fixture.pins,
    }
    const client = new ClientV2("private-fixture", setup)
    const result = await client.context("Eden", 1000, {
      id: fixture.selected.request,
      before: async (request) => {
        before.push(request)
      },
    })
    expect(result.sources.some((row) => row.text.includes("café 日本語 😀"))).toBe(true)
    expect(result.tokens).toBeLessThanOrEqual(1000)
    expect(result.capture_enabled).toBe(false)
    expect(posts).toEqual([fixture.body])
    expect(before.length).toBe(1)
    const fresh = new ClientV2("private-fixture", setup)
    await expect(
      fresh.context("Eden", 0, {
        id: "c".repeat(32),
        before: async () => {
          before.push("unexpected")
        },
      }),
    ).rejects.toThrow()
    expect(posts.length).toBe(1)
    expect(before.length).toBe(1)
    const older = new ClientV2("private-fixture", {
      ...setup,
      source_sha256: { ...fixture.pins, "server.py": "0".repeat(64) },
    })
    await expect(
      older.context("Eden", 1000, {
        id: "d".repeat(32),
        before: async () => {
          before.push("unexpected old release")
        },
      }),
    ).rejects.toThrow("context-capable")
    expect(posts.length).toBe(1)
    expect(before.length).toBe(1)
  } finally {
    await server.stop(true)
  }
})
