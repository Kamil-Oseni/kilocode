import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BrainSettings } from "../../src/second-brain/settings"
import { BrainService } from "../../src/second-brain/service"
import { BrainControl, type Session } from "../../src/second-brain/control"
import { parseCatalog } from "../../src/second-brain/control/catalog"
import { release, bridge } from "../../src/second-brain/control/catalog-v2"

const source = path.resolve(import.meta.dir, "../../script/memory/service")
const python = process.env.RAYA_MEMORY_OPERATION_PYTHON
const genuine = python ? test : test.skip
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const digest = sha(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(release).sort()))))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-memory-host-v2-"))
  const file = path.join(dir, "state.json")
  const secret = path.join(dir, "synthetic.json")
  await Promise.all([writeFile(file, "{}"), writeFile(secret, "{}")])
  const settings = new BrainSettings(
    {
      get<T>(key: string) {
        return JSON.parse(readFileSync(file, "utf8"))[key] as T | undefined
      },
      async update(key, value) {
        const row = JSON.parse(await readFile(file, "utf8"))
        if (value === undefined) delete row[key]
        else row[key] = value
        await writeFile(file, JSON.stringify(row))
      },
    },
    {
      async get(key) {
        return JSON.parse(await readFile(secret, "utf8"))[key]
      },
      async store(key, value) {
        const row = JSON.parse(await readFile(secret, "utf8"))
        row[key] = value
        await writeFile(secret, JSON.stringify(row))
      },
      async delete(key) {
        const row = JSON.parse(await readFile(secret, "utf8"))
        delete row[key]
        await writeFile(secret, JSON.stringify(row))
      },
    },
  )
  const frames = new Map<string, unknown>()
  const calls: string[] = []
  const epoch = { value: "a".repeat(32) }
  const barrier = deferred()
  const began = deferred()
  const mode = { held: false }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      calls.push(request.method + " " + url.pathname)
      expect(request.headers.get("Authorization")).toBe("Bearer synthetic-only")
      if (url.pathname === "/health")
        return Response.json({
          ready: true,
          namespace_valid: true,
          draining: false,
          retirement_pending: false,
          retirement_unconfirmed: false,
          active: 0,
          capture_enabled: false,
          admission_required: true,
          root: "C:/Synthetic",
          source_sha256: release,
          owner_epoch: epoch.value,
          selected_release_sha256: digest,
          operation_protocol: "raya.memory.operation.v1",
        })
      const id = request.headers.get("X-Raya-Memory-Request-ID")!
      expect(id).toMatch(/^[a-f0-9]{32}$/)
      expect(request.headers.get("X-Raya-Memory-Owner-Epoch")).toBe(epoch.value)
      if (request.method === "GET") return Response.json(frames.get(id))
      if (request.method === "DELETE")
        return Response.json({ request: id, owner_epoch: epoch.value, retirement_acknowledged: false })
      expect(settings.pending()).toMatchObject({ version: 2, root: "C:\\Synthetic", request: { id } })
      expect(request.method).toBe("POST")
      const body = await request.json()
      expect(sha(await readFile(python!))).toBe("b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2")
      const child = Bun.spawn(
        [python!, "-I", "-S", "-B", path.join(import.meta.dir, "fixtures/memory-host-v2-producer.py"), source!],
        {
          windowsHide: true,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: dir, TMP: dir },
        },
      )
      child.stdin.write(
        JSON.stringify({ id, epoch: epoch.value, kind: url.pathname.endsWith("sync") ? "sync" : "search", body, release }),
      )
      child.stdin.end()
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).toBe(0)
      expect(err).toBe("")
      const value = JSON.parse(out)
      frames.set(id, value.terminal)
      began.resolve()
      if (mode.held) await barrier.promise
      return Response.json(value.response)
    },
  })
  await settings.save(
    {
      format: "raya.memory.setup",
      version: 2,
      protocol: "raya.memory.operation.v1",
      root: "C:\\Synthetic",
      origin: `http://127.0.0.1:${server.port}`,
      source_sha256: release,
    },
    "synthetic-only",
  )
  const service = new BrainService(settings)
  return {
    settings,
    service,
    calls,
    epoch,
    mode,
    began,
    barrier,
    async close() {
      barrier.resolve()
      const closed = await service.dispose().then(
        () => undefined,
        (err: unknown) => err,
      )
      await server.stop(true)
      const target = path.resolve(dir)
      expect(path.dirname(target)).toBe(path.resolve(tmpdir()))
      expect(path.basename(target)).toMatch(/^raya-memory-host-v2-/)
      await rm(target, { recursive: true })
      return closed
    },
  }
}

test("selected v5 catalog refuses mixed legacy and unreviewed releases", () => {
  const value = {
    format: "raya.memory.control.catalog",
    version: 2,
    python: "C:/Synthetic/python.exe",
    source: "C:/Synthetic/source",
    bridge: "C:/Synthetic/bridge.py",
    python_sha256: "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2",
    bridge_sha256: bridge,
    source_sha256: release,
  }
  expect(parseCatalog(value).version).toBe(2)
  for (const [name, hash] of Object.entries(release))
    expect(sha(readFileSync(new URL(`../../script/memory/service/${name}`, import.meta.url)))).toBe(hash)
  expect(() => parseCatalog({ ...value, version: 1 })).toThrow()
  expect(() => parseCatalog({ ...value, source_sha256: { ...release, "server.py": "0".repeat(64) } })).toThrow()
  expect(() =>
    parseCatalog({
      ...value,
      source_sha256: { ...release, "index.py": "b735d8c446a62084ab43ad1a4cdc0a8a4362111d5bb995f639ff871009495be4" },
    }),
  ).toThrow()
  expect(() =>
    parseCatalog({
      ...value,
      source_sha256: { ...release, "namespace.py": "5cc018c7340b6225544ab43120a71eadcd1699ad38a05be7df3826115c7689b3" },
    }),
  ).toThrow()
})

genuine("real settings, service and selected Journal complete one search with exact Windows root debt", async () => {
  const value = await fixture()
  try {
    const states: unknown[] = []
    await value.service.run("Synthetic café 日本語 😀", (state) => states.push(state))
    expect(states.at(-1)).toMatchObject({ status: "ready", results: [] })
    expect(value.calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /v1/memory/search"])
    expect(value.calls.filter((call) => call.startsWith("GET /v1"))).toHaveLength(1)
    expect(value.settings.pending()).toBeUndefined()
    value.epoch.value = "b".repeat(32)
    await expect(value.service.run("Synthetic again", (state) => states.push(state))).rejects.toMatchObject({
      code: "identity_mismatch",
    })
    expect(states.at(-1)).toMatchObject({ status: "unavailable", code: "identity_mismatch" })
    expect(value.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1)
  } finally {
    await value.close()
  }
})

genuine("native confirmed sync joins original control close before clearing operation debt", async () => {
  const value = await fixture()
  const held = deferred()
  const closing = deferred()
  let count = 0
  const session = {
    async state() {
      return { policy_sha256: "e".repeat(64), policy: { enabled: true, root: "C:\\Synthetic", revision: 1, files: [] } }
    },
    async close() {
      count++
      closing.resolve()
      await held.promise
      return { code: 0, signal: null, stdout: true, stderr: true, errors: [] }
    },
    snapshot() {
      return {}
    },
    fence() {},
  } as Session
  const control = new BrainControl(value.service, value.settings, async () => session)
  try {
    const job = control.sync(
      async (review) => {
        expect(review.enabled).toBe(true)
        return true
      },
      (expected, signal, close) => value.service.sync(expected, signal, close),
    )
    await closing.promise
    expect(value.settings.pending()).toMatchObject({ version: 2, request: { op: "sync" } })
    held.resolve()
    await job
    expect(count).toBe(1)
    expect(control.snapshot()).toMatchObject({ status: "synced" })
    expect(value.settings.pending()).toBeUndefined()
  } finally {
    held.resolve()
    await control.dispose()
    await value.close()
  }
})

genuine("original control close failure retains sync debt and refuses next operation", async () => {
  const value = await fixture()
  const cause = new Error("synthetic original close failure")
  try {
    await expect(
      value.service.configure(() =>
        value.service.sync("e".repeat(64), new AbortController().signal, async () => {
          throw cause
        }),
      ),
    ).rejects.toBe(cause)
    expect(value.settings.pending()).toMatchObject({ version: 2, request: { op: "sync" } })
    await expect(value.service.run("No replay", () => {})).rejects.toThrow("reconciliation")
    expect(value.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1)
  } finally {
    expect(await value.close()).toBeDefined()
  }
})

genuine("native transaction retains a sole original close error without duplicate aggregation", async () => {
  const value = await fixture()
  const cause = new Error("synthetic original native closure")
  const session = {
    async state() {
      return { policy_sha256: "e".repeat(64), policy: { enabled: true, root: "C:\\Synthetic", revision: 1, files: [] } }
    },
    async close() {
      throw cause
    },
    snapshot() {
      return {}
    },
    fence() {},
  } as Session
  const control = new BrainControl(value.service, value.settings, async () => session)
  try {
    await expect(
      control.sync(
        async () => true,
        (expected, signal, close) => value.service.sync(expected, signal, close),
      ),
    ).rejects.toBe(cause)
    expect(control.snapshot()).toMatchObject({ status: "uncertain" })
    expect(value.settings.pending()).toMatchObject({ version: 2, request: { op: "sync" } })
  } finally {
    await expect(control.dispose()).rejects.toBe(cause)
    expect(await value.close()).toBeDefined()
  }
})

genuine("accepted search refuses another panel while its original body is held", async () => {
  const value = await fixture()
  try {
    value.mode.held = true
    const job = value.service.run("Synthetic first", () => {})
    await value.began.promise
    await expect(value.service.run("No replacement", () => {})).rejects.toThrow("still settling")
    expect(value.settings.pending()).toBeDefined()
    value.barrier.resolve()
    await job
    expect(value.settings.pending()).toBeUndefined()
    expect(value.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1)
  } finally {
    await value.close()
  }
})

genuine("configuration joins cancelled original search and preserves restart debt without publication", async () => {
  const value = await fixture()
  let published = false
  try {
    value.mode.held = true
    const states: unknown[] = []
    const job = value.service.run("Synthetic cancelled", (state) => states.push(state))
    const cancelled = job.then(
      () => undefined,
      (err: unknown) => err,
    )
    await value.began.promise
    const change = value.service.configure(async () => {
      published = true
    })
    const refusal = change.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(await cancelled).toMatchObject({ name: "AbortError" })
    expect(await refusal).toBeDefined()
    expect(published).toBe(false)
    expect(states.at(-1)).not.toMatchObject({ status: "ready" })
    expect(value.settings.pending()).toMatchObject({ version: 2, request: { op: "search" } })
    expect(value.calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(1)
    expect(value.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1)
    await expect(value.settings.load()).rejects.toThrow("pending original settlement")
    expect(await value.service.status()).toMatchObject({ status: "unavailable", code: "control_uncertain" })
  } finally {
    expect(await value.close()).toBeDefined()
  }
})

genuine("native sync cancellation sends no POST and synchronous second panel cannot replace first intake", async () => {
  const value = await fixture()
  const session = {
    async state() {
      return { policy_sha256: "e".repeat(64), policy: { enabled: true, root: "C:\\Synthetic", revision: 1, files: [] } }
    },
    async close() {
      return { code: 0, signal: null, stdout: true, stderr: true, errors: [] }
    },
    snapshot() {
      return {}
    },
    fence() {},
  } as Session
  const control = new BrainControl(value.service, value.settings, async () => session)
  try {
    await control.sync(
      async () => false,
      (expected, signal, close) => value.service.sync(expected, signal, close),
    )
    expect(value.calls).toEqual([])
    const job = value.service.run("Synthetic immediate", () => {})
    await expect(value.service.run("Immediate replacement", () => {})).rejects.toThrow("still settling")
    await job
    expect(value.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1)
  } finally {
    await control.dispose()
    await value.close()
  }
})

genuine(
  "policy control exclusivity preserves successful search selection and refuses a replacement worker",
  async () => {
    const value = await fixture()
    const session = {
      async state() {
        return {
          policy_sha256: "e".repeat(64),
          policy: { enabled: true, root: "C:\\Synthetic", revision: 1, files: [] },
        }
      },
      async close() {
        return { code: 0, signal: null, stdout: true, stderr: true, errors: [] }
      },
      snapshot() {
        return {}
      },
      fence() {},
    } as Session
    const control = new BrainControl(value.service, value.settings, async () => session)
    try {
      await value.service.run("Synthetic selected", () => {})
      value.epoch.value = "b".repeat(32)
      await expect(
        control.sync(
          async () => true,
          (expected, signal, close) => value.service.sync(expected, signal, close),
        ),
      ).rejects.toThrow("original Memory owner changed")
      expect(value.calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /v1/memory/search"])
      expect(value.settings.pending()).toBeUndefined()
      expect(control.snapshot()).toMatchObject({ status: "uncertain" })
    } finally {
      await control.dispose()
      expect(await value.close()).toBeDefined()
    }
  },
)
