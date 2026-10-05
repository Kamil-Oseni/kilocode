import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BrainControl } from "../../src/second-brain/control"
import { Control, packaged, parseCatalog } from "../../src/second-brain/control/index"
import { protect } from "../../src/second-brain/control/protection"
import { BrainSettings } from "../../src/second-brain/settings"
import { BrainService } from "../../src/second-brain/service"
import { BrainClient } from "../../src/second-brain/client"
import { Transport } from "../../src/second-brain/control/transport"
import { observe } from "../../src/second-brain/control/identity"
import { spawn } from "../../src/util/process"
import { drain, register } from "../../src/second-brain/retirement"
import { join } from "../../src/second-brain/join"

const sources = {
  "server.py": "51a19ed48dc3ec36ca608a141b3d1acca681c6993dde189ac8fc2ab04ae288b2",
  "index.py": "6ce3985be9f34ef758f02091ce8052a181a8ece154fc6ef6bc3649e11ba984f9",
  "notes.py": "59488d324200d95b0974bfa119215de627bc1b17dd3233fc6b02ab137b651923",
  "policy.py": "87c931cfa7cceb7386e6d2b4b05fdacf916360fd2cb0ff590d0fccf5dd334ae2",
  "admission.py": "5a4ae56bc2a5d55e0a1dab14c1401a98b56ebc5fedf9b8bd5312d84899877770",
  "host.py": "4854ab90b06085450136e764ec1f70034ae27c597af9b6fa98a99860aa049a97",
}
const catalog = parseCatalog({
  format: "raya.memory.control.catalog",
  version: 1,
  python: "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
  source: "D:/Raya/Services/Memory/Candidates/GeneralAdmission-20261003-v7",
  bridge: "D:/Raya/Services/Memory/Candidates/TrustedHostStdio-20261003-v2/bridge.py",
  python_sha256: "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2",
  bridge_sha256: "d135c8c3f6a0ca8c2a746f5c7ac74f65909ff4ee4a7df8a1459a31ddb1c1abe5",
  source_sha256: sources,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(update?: (key: string, value: unknown) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-memory-control-host-test-"))
  await protect(dir)
  const root = path.join(dir, "notes")
  await mkdir(root)
  await mkdir(path.join(root, "System"))
  await writeFile(path.join(root, "first.md"), "Synthetic café 日本 😀\n", { flag: "wx" })
  await writeFile(path.join(root, "removed.md"), "Only synthetic removed text\n", { flag: "wx" })
  const values = new Map<string, unknown>()
  const keys = new Map<string, string>()
  const stored = path.join(dir, "settings.private.json")
  const settings = new BrainSettings(
    {
      get<T>(key: string) {
        return values.get(key) as T | undefined
      },
      async update(key, value) {
        values.set(key, value)
        await writeFile(stored, JSON.stringify(Object.fromEntries(values)))
        await update?.(key, value)
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
  await settings.save(
    {
      format: "raya.memory.setup",
      version: 1,
      root,
      origin: "http://127.0.0.1:8774",
      source_sha256: Object.fromEntries(Object.entries(sources).filter(([name]) => name !== "host.py")),
    },
    "synthetic-private-key",
  )
  const extension = path.resolve(".")
  await packaged(extension)
  const service = new BrainService(settings)
  const control = new BrainControl(service, settings, (setup) => Control.open(setup.root, catalog, extension))
  return { root, settings, service, control, stored, extension }
}

test("actual pinned child publishes only after native callback, journals before publication and retains complete removal review", async () => {
  const value = await fixture()
  try {
    await value.control.review(["first.md", "removed.md"], true, async (review) => {
      expect(review.text).toContain("Synthetic café 日本 😀")
      expect(review.text).toContain("Original policy SHA-256: null")
      return true // Synthetic callback authority, never claimed as native human consent.
    })
    expect(value.settings.pending()).toBeUndefined()
    expect(value.control.snapshot().status).toBe("approved")
    await value.control.review(["first.md"], true, async (review) => {
      expect(review.text).toContain("Removed sources:\nremoved.md SHA-256")
      expect(review.text).toContain("complete source allowlist")
      return false
    })
    const policy = JSON.parse(await readFile(path.join(value.root, "System", "general-admission.json"), "utf8"))
    expect(policy.files).toHaveLength(2)
    await value.control.pause(async (review) => {
      expect(review.enabled).toBe(false)
      return true
    })
    expect(value.control.snapshot().status).toBe("policy_disabled")
    expect(value.control.snapshot().hostJoinRequired).toBe(true)
    expect(value.settings.pending()).toBeUndefined()
    expect((await readFile(value.stored, "utf8")).includes("Synthetic café")).toBe(false)
  } finally {
    await Promise.all([value.control.dispose(), value.service.dispose()])
  }
}, 60000)

test("real held native review cannot publish after shared cutoff and blocks competing search until child closure", async () => {
  const value = await fixture()
  const ready = deferred<void>()
  const release = deferred<boolean>()
  const operation = value.control.review(["first.md"], true, async () => {
    ready.resolve()
    return release.promise
  })
  const result = operation.then(
    () => undefined,
    (error: unknown) => error,
  )
  await ready.promise
  await expect(value.service.run("synthetic", () => undefined)).rejects.toThrow("changing")
  const stopped = value.control.stop()
  release.resolve(true)
  await stopped
  expect(await result).toBeInstanceOf(Error)
  expect(await Bun.file(path.join(value.root, "System", "general-admission.json")).exists()).toBe(false)
  expect(value.settings.pending()).toBeUndefined()
  await Promise.all([value.control.dispose(), value.service.dispose()])
}, 60000)

test("actual sync HTTP requires exact current policy and bounds reply without sending credentials to any public projection", async () => {
  const requests: unknown[] = []
  const pins = Object.fromEntries(Object.entries(sources).filter(([name]) => name !== "host.py"))
  const root = "C:/Synthetic/Only"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/health")
        return Response.json({
          root,
          source_sha256: pins,
          active: 0,
          namespace_valid: true,
          ready: true,
          draining: false,
          retirement_pending: false,
          retirement_unconfirmed: false,
          admission_required: true,
          capture_enabled: false,
        })
      requests.push(await request.json())
      return Response.json({ files: 1, chunks: 2, new_embeddings: 1, reused_embeddings: 1 })
    },
  })
  try {
    const client = new BrainClient("synthetic-private-key", {
      format: "raya.memory.setup",
      version: 1,
      origin: server.url.origin,
      root,
      source_sha256: pins,
    })
    await client.sync("a".repeat(64))
    expect(requests).toEqual([{ force_rebuild: false, expected_policy_sha256: "a".repeat(64) }])
    expect(JSON.stringify(requests)).not.toContain("synthetic-private-key")
    await expect(client.sync("unknown")).rejects.toThrow("Confirmed")
    expect(requests).toHaveLength(1)
  } finally {
    await server.stop(true)
  }
})

test("actual journal publication precedes frame, cutoff preserves inert debt across restart and never replays", async () => {
  const ready = deferred<void>()
  const release = deferred<void>()
  const value = await fixture(async (key, input) => {
    if (key !== "raya.secondBrain.control.uncertainty" || input === undefined) return
    ready.resolve()
    await release.promise
  })
  const operation = value.control.review(["first.md"], true, async () => true)
  const result = operation.then(
    () => undefined,
    (error: unknown) => error,
  )
  await ready.promise
  expect(value.settings.pending()).toBeDefined()
  expect(await Bun.file(path.join(value.root, "System", "general-admission.json")).exists()).toBe(false)
  const stopped = value.control.stop().then(
    () => undefined,
    (error: unknown) => error,
  )
  release.resolve()
  expect(await result).toBeInstanceOf(Error)
  expect(await stopped).toBeInstanceOf(Error)
  expect(Control.held()).toEqual([])
  expect(value.settings.pending()).toBeDefined()
  const saved = JSON.parse(await readFile(value.stored, "utf8")) as Record<string, unknown>
  const reopened = new BrainSettings(
    {
      get<T>(key: string) {
        return saved[key] as T | undefined
      },
      async update() {
        throw new Error("No replay publication permitted")
      },
    },
    {
      async get() {
        return undefined
      },
      async store() {},
      async delete() {},
    },
  )
  const service = new BrainService(reopened)
  expect((await service.status()).code).toBe("control_uncertain")
  await expect(service.run("synthetic", () => undefined)).rejects.toThrow("reconciliation")
  expect(JSON.stringify(saved)).not.toContain("Synthetic café")
  expect(await Bun.file(path.join(value.root, "System", "general-admission.json")).exists()).toBe(false)
  await service.dispose()
  await value.service.dispose()
  await expect(value.control.dispose()).rejects.toThrow()
}, 60000)

test("genuine verified publication followed by nonzero EOF closure retains durable uncertainty", async () => {
  const value = await fixture()
  const bootstrap = path.join(path.dirname(value.stored), "bootstrap.private.json")
  await writeFile(
    bootstrap,
    JSON.stringify({
      format: "raya.memory.control.setup",
      version: 1,
      root: value.root,
      source_dir: catalog.source,
      source_sha256: catalog.source_sha256,
    }),
    { flag: "wx" },
  )
  const control = new BrainControl(value.service, value.settings, async () => {
    const child = spawn(
      catalog.python,
      ["-I", "-u", path.resolve(import.meta.dir, "../fixtures/second-brain-control-close.py"), bootstrap],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    )
    const transport = new Transport(child, value.root)
    transport.bind(
      await observe(
        child,
        catalog.python,
        path.join(value.extension, "bin", "raya-process-host.exe"),
        catalog.python_sha256,
      ),
    )
    return transport
  })
  await expect(control.review(["first.md"], true, async () => true)).rejects.toThrow("closure")
  expect(Control.held()).toEqual([])
  expect(control.snapshot().status).toBe("uncertain")
  expect(value.settings.pending()).toBeDefined()
  const policy = JSON.parse(await readFile(path.join(value.root, "System", "general-admission.json"), "utf8"))
  expect(policy.enabled).toBe(true)
  const request = value.settings.pending()!.request as { mutation: { prospective: string } }
  const raw = await readFile(path.join(value.root, "System", "general-admission.json"))
  expect(new Bun.CryptoHasher("sha256").update(raw).digest("hex")).toBe(request.mutation.prospective)
  await expect(control.dispose()).rejects.toThrow()
  await value.service.dispose()
  await value.control.dispose()
}, 60000)

test("actual coordinator sync journals exact mixed-case Windows root and request header before loopback POST", async () => {
  const value = await fixture()
  await value.control.review(["first.md"], true, async () => true)
  expect(value.root).toMatch(/^C:\\Users\\/)
  const pins = Object.fromEntries(Object.entries(sources).filter(([name]) => name !== "host.py"))
  let posts = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/health")
        return Response.json({
          root: value.root,
          source_sha256: pins,
          active: 0,
          namespace_valid: true,
          ready: true,
          draining: false,
          retirement_pending: false,
          retirement_unconfirmed: false,
          admission_required: true,
          capture_enabled: false,
        })
      posts++
      const debt = value.settings.pending()!
      const metadata = debt.request as { id: string; root: string; expected: string }
      expect(debt.root).toBe(value.root)
      expect(metadata.root).toBe(value.root)
      expect(request.headers.get("X-Raya-Request-ID")).toBe(metadata.id)
      expect(await request.json()).toEqual({ force_rebuild: false, expected_policy_sha256: metadata.expected })
      return Response.json({ files: 1, chunks: 1, new_embeddings: 1, reused_embeddings: 0 })
    },
  })
  await value.settings.save(
    { format: "raya.memory.setup", version: 1, root: value.root, origin: server.url.origin, source_sha256: pins },
    "synthetic-private-key",
  )
  try {
    await value.control.sync(
      async () => true,
      async (expected, signal) => {
        const cfg = (await value.settings.load())!
        const client = new BrainClient(cfg.key, cfg.setup)
        await client.sync(expected, signal, (request) =>
          value.settings.record({
            format: "raya.memory.control.uncertainty",
            version: 1,
            root: cfg.setup.root,
            request,
          }),
        )
      },
    )
    expect(posts).toBe(1)
    expect(value.control.snapshot().status).toBe("synced")
    expect(value.settings.pending()).toBeUndefined()
  } finally {
    await server.stop(true)
    await Promise.all([value.control.dispose(), value.service.dispose()])
  }
}, 60000)

test("synchronous public retirement fences every coordinator before joining actual held review", async () => {
  if (process.env.RAYA_MEMORY_CONTROL_DRAIN_CHILD !== "1") {
    const child = Bun.spawn(
      [process.execPath, "test", import.meta.path, "--test-name-pattern", "synchronous public retirement"],
      {
        windowsHide: true,
        env: { ...process.env, RAYA_MEMORY_CONTROL_DRAIN_CHILD: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
    return
  }
  const value = await fixture()
  const ready = deferred<void>()
  const release = deferred<boolean>()
  const operation = value.control
    .review(["first.md"], true, async () => {
      ready.resolve()
      return release.promise
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    )
  await ready.promise
  register(() => join([value.control.dispose(), value.service.dispose(), Control.drain()]))
  const closure = drain()
  await expect(value.service.run("synthetic", () => undefined)).rejects.toThrow("closed")
  await expect(value.control.review(["first.md"], true, async () => true)).rejects.toThrow("busy")
  expect(() => Control.open(value.root, catalog, value.extension)).toThrow("owned")
  release.resolve(false)
  expect(await operation).toBeInstanceOf(Error)
  await closure
  expect(Control.held()).toEqual([])
  await drain()
}, 60000)
