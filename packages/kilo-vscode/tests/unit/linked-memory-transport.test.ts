import { expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { ClientV2 } from "../../src/second-brain/client-v2"
import { parse } from "../../src/second-brain/operation"
import { context } from "../../src/second-brain/linked-results"

const python = process.env.RAYA_LINKED_TEST_PYTHON
const genuine = python ? test : test.skip

genuine(
  "published note recall refuses old policy and old search seeds before returning the reviewed revision",
  async () => {
    const child = Bun.spawn(
      [
        python!,
        "-I",
        "-S",
        "-B",
        path.join(import.meta.dir, "fixtures/linked-memory-producer.py"),
        path.join(import.meta.dir, "../../script/memory/service"),
        "--publication",
      ],
      { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(error).toBe("")
    expect(code).toBe(0)
    const fixture = JSON.parse(output)
    expect(fixture.applied.status).toBe("applied")
    expect(fixture.applied.receipt.status).toBe("committed")
    expect(fixture.applied.changes[0].content).toBe(fixture.content)
    const published = Buffer.from(fixture.published, "base64")
    expect(published.toString("utf8").startsWith(fixture.content)).toBe(true)
    expect(createHash("sha256").update(published).digest("hex")).toBe(fixture.sha256)
    expect(fixture.applied.receipt.note_sha256[fixture.name]).toBe(fixture.sha256)
    expect(fixture.sha256).not.toBe(fixture.previous)
    const stale = context(fixture.stale, fixture.root, 1000)
    expect(stale.sources.some((row) => row.relative === fixture.name)).toBe(false)
    expect(stale.diagnostics.some((row) => row.relative === fixture.name)).toBe(true)
    const seed = context(fixture.oldseed, fixture.root, 1000)
    expect(seed.sources.some((row) => row.relative === fixture.name)).toBe(false)
    expect(seed.diagnostics.some((row) => row.reason === "Search seed revision is stale.")).toBe(true)
    const fresh = context(fixture.fresh, fixture.root, 1000)
    const note = fresh.sources.find((row) => row.relative === fixture.name)
    expect(note?.source_sha256).toBe(fixture.sha256)
    expect(note?.text).toContain("warm amber café lighting 日本語 😀")
    expect(fresh.tokens).toBeLessThanOrEqual(1000)
    expect(fresh.capture_enabled).toBe(false)
    expect(fixture.proposal_unchanged).toBe(true)
    expect(fixture.note_unchanged).toBe(true)
  },
)

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
