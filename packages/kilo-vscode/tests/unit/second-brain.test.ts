import { expect, test } from "bun:test"
import { BrainClient, Failure } from "../../src/second-brain/client"
import { BrainSettings, files, parse } from "../../src/second-brain/settings"
import { BrainService } from "../../src/second-brain/service"
import type { BrainState } from "../../src/shared/second-brain"
import { manifest } from "../../src/second-brain/manifest"
import { mkdtemp, writeFile, link, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const pins = Object.fromEntries(files.map((name) => [name, "a".repeat(64)]))
const root = "C:/Synthetic/SecondBrain"

test("real selected setup file is bounded, pinned and refuses hard-linked metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-brain-setup-"))
  const file = join(dir, "setup.json")
  const setup = { format: "raya.memory.setup", version: 1, origin: "http://127.0.0.1:8774", root, source_sha256: pins }
  try {
    await writeFile(file, JSON.stringify(setup))
    expect(await manifest(file)).toEqual(setup)
    await link(file, join(dir, "other.json"))
    await expect(manifest(file)).rejects.toThrow("ordinary")
    await rm(join(dir, "other.json"))
    await writeFile(file, Buffer.alloc(16_385))
    await expect(manifest(file)).rejects.toThrow("bounded")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function storage() {
  const data = new Map<string, unknown>()
  const keys = new Map<string, string>()
  return new BrainSettings(
    {
      get<T>(key: string) {
        return data.get(key) as T | undefined
      },
      async update(key, value) {
        data.set(key, value)
      },
    },
    {
      async get(key) {
        return keys.get(key)
      },
      async store(key, value) {
        keys.set(key, value)
      },
      async delete(key) {
        keys.delete(key)
      },
    },
  )
}

test("context coordinator refuses legacy setup and cancelled input without starting search", async () => {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.method)
      return Response.json({})
    },
  })
  const settings = storage()
  await settings.save(
    { format: "raya.memory.setup", version: 1, origin: server.url.origin, root, source_sha256: pins },
    "private-fixture-key",
  )
  const service = new BrainService(settings)
  try {
    await expect(service.context("preference", 1000, new AbortController().signal)).rejects.toThrow("Reviewed v2")
    const parent = new AbortController()
    parent.abort(new Error("private cancellation"))
    await expect(service.context("preference", 1000, parent.signal)).rejects.toThrow("private cancellation")
    await expect(service.context(" ", 1000, new AbortController().signal)).rejects.toThrow("bounded")
    expect(requests).toEqual([])
    expect(settings.pending()).toBeUndefined()
  } finally {
    await service.dispose()
    await server.stop()
  }
})

test("explicit setup validates loopback and exact five pins without storing credentials in public state", async () => {
  const store = storage()
  expect(await store.load()).toBeUndefined()
  const setup = { format: "raya.memory.setup", version: 1, origin: "http://127.0.0.1:8774", root, source_sha256: pins }
  expect(() => parse({ ...setup, origin: "https://external.example" })).toThrow()
  expect(() => parse({ ...setup, source_sha256: { ...pins, extra: "a".repeat(64) } })).toThrow()
  await store.save(setup, "synthetic-host-private-key")
  expect((await store.load())?.setup).not.toHaveProperty("key")
  await store.clear()
  expect(await store.load()).toBeUndefined()
})

test("actual loopback identity and typed refusal stop all search POSTs", async () => {
  const state = {
    ready: true,
    namespace_valid: true,
    retirement_pending: false,
    retirement_unconfirmed: false,
    draining: false,
    active: 0,
    admission_required: true,
    capture_enabled: false,
    root,
    source_sha256: pins,
  }
  let health = { ...state }
  let posts = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer synthetic")
      if (new URL(request.url).pathname === "/health") return Response.json(health)
      posts++
      return Response.json({
        capture_enabled: false,
        results: [
          {
            relative: "General.md",
            path: root + "/General.md",
            line: 1,
            end_line: 2,
            heading: "Synthetic",
            text: "café 日本語 😀",
            source_sha256: "b".repeat(64),
            embedding_similarity: 0.5,
            relevance_score: 0.9,
          },
        ],
      })
    },
  })
  try {
    const client = new BrainClient(
      "synthetic",
      parse({ format: "raya.memory.setup", version: 1, origin: server.url.origin, root, source_sha256: pins }),
    )
    const result = await client.search("Synthetic")
    expect(result.results[0].text).toBe("café 日本語 😀")
    expect(Object.isFrozen(result.results[0])).toBe(true)
    for (const [code, patch] of [
      ["namespace_changed", { namespace_valid: false }],
      ["retirement_pending", { retirement_pending: true }],
      ["retirement_unconfirmed", { retirement_unconfirmed: true }],
      ["service_draining", { draining: true }],
      ["identity_mismatch", { source_sha256: { ...pins, "server.py": "c".repeat(64) } }],
    ] as const) {
      health = { ...state, ...patch }
      const err = await client.search("Must not forward").catch((err: unknown) => err)
      expect(err).toBeInstanceOf(Failure)
      expect((err as Failure).code).toBe(code)
      expect(posts).toBe(1)
    }
  } finally {
    await server.stop(true)
  }
})

test("shared host coordinator defaults disconnected and fences cancelled or replaced results through joined disposal", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const rows: BrainState[] = []
  const settings = storage()
  const service = new BrainService(settings)
  await service.run("No configuration", (value) => rows.push(value))
  expect(rows.at(-1)?.status).toBe("disconnected")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/health")
        return Response.json({
          ready: true,
          namespace_valid: true,
          retirement_pending: false,
          retirement_unconfirmed: false,
          draining: false,
          active: 0,
          admission_required: true,
          capture_enabled: false,
          root,
          source_sha256: pins,
        })
      entered.resolve()
      await release.promise
      return Response.json({ capture_enabled: false, results: [] })
    },
  })
  try {
    await settings.save(
      { format: "raya.memory.setup", version: 1, origin: server.url.origin, root, source_sha256: pins },
      "synthetic",
    )
    const owner = {}
    const pending = service.run("Synthetic", (value) => rows.push(value), owner)
    await entered.promise
    await service.stop({})
    expect(rows.at(-1)?.status).toBe("searching")
    await service.stop(owner)
    await pending
    expect(rows.at(-1)?.status).toBe("cancelled")
    expect(rows.every((value) => !JSON.stringify(value).includes('"key"'))).toBe(true)
    release.resolve()
    await service.run(undefined, (value) => rows.push(value))
    expect(rows.at(-1)?.status).toBe("ready")
    await service.configure(async () => {})
    expect(await service.status()).toMatchObject({ configured: true, status: "disconnected", results: [] })
    await service.dispose()
    await expect(service.run("Late", () => {})).rejects.toThrow("closed")
  } finally {
    release.resolve()
    await service.dispose()
    await server.stop(true)
  }
})

test("failed search retains fresh backend retirement refusal instead of claiming local cancellation retires its worker", async () => {
  const settings = storage()
  const service = new BrainService(settings)
  const rows: BrainState[] = []
  let failed = false
  let gets = 0
  let posts = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/health") {
        gets++
        return Response.json({
          ready: !failed,
          namespace_valid: true,
          retirement_pending: failed,
          retirement_unconfirmed: failed,
          draining: false,
          active: 0,
          admission_required: true,
          capture_enabled: false,
          root,
          source_sha256: pins,
        })
      }
      posts++
      failed = true
      return Response.json(
        { error: { code: "retirement_unconfirmed", message: "Synthetic pending worker" } },
        { status: 503 },
      )
    },
  })
  try {
    await settings.save(
      { format: "raya.memory.setup", version: 1, origin: server.url.origin, root, source_sha256: pins },
      "synthetic",
    )
    await service.run("Synthetic", (row) => rows.push(row))
    expect(gets).toBe(2)
    expect(rows.at(-1)).toMatchObject({ status: "unavailable", code: "retirement_unconfirmed", results: [] })
    await service.run("Must not forward", (row) => rows.push(row))
    expect(posts).toBe(1)
    expect(rows.at(-1)?.code).toBe("retirement_unconfirmed")
  } finally {
    await service.dispose()
    await server.stop(true)
  }
})

test("configuration fences shared intake through actual held HTTP cleanup and secret/setup publication", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const publishing = Promise.withResolvers<void>()
  const publication = Promise.withResolvers<void>()
  const settings = storage()
  const service = new BrainService(settings)
  const rows: BrainState[] = []
  let posts = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/health")
        return Response.json({
          ready: true,
          namespace_valid: true,
          retirement_pending: false,
          retirement_unconfirmed: false,
          draining: false,
          active: 0,
          admission_required: true,
          capture_enabled: false,
          root,
          source_sha256: pins,
        })
      posts++
      entered.resolve()
      await release.promise
      return Response.json({ capture_enabled: false, results: [] })
    },
  })
  const cfg = { format: "raya.memory.setup", version: 1, origin: server.url.origin, root, source_sha256: pins }
  try {
    await settings.save(cfg, "synthetic-old")
    const pending = service.run("Synthetic old request", (row) => rows.push(row), {})
    await entered.promise
    const change = service.configure(async () => {
      publishing.resolve()
      await publication.promise
      await settings.save({ ...cfg, root: root + "-new" }, "synthetic-new")
    })
    await expect(service.run("Must not enter", () => {})).rejects.toMatchObject({ code: "setup_changing" })
    await publishing.promise
    await expect(service.disconnect()).rejects.toMatchObject({ code: "setup_changing" })
    expect((await settings.load())?.key).toBe("synthetic-old")
    publication.resolve()
    await change
    await pending
    release.resolve()
    expect(posts).toBe(1)
    expect(rows.some((row) => row.status === "ready")).toBe(false)
    expect(await service.status()).toMatchObject({ configured: true, status: "disconnected", results: [] })
    expect(await settings.load()).toMatchObject({ key: "synthetic-new", setup: { root: root + "-new" } })
    await service.disconnect()
    expect(await service.status()).toMatchObject({ configured: false, status: "disconnected" })
  } finally {
    publication.resolve()
    release.resolve()
    await service.dispose()
    await server.stop(true)
  }
})
