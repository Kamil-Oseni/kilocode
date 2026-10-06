import { expect, test } from "bun:test"
import { release } from "../../src/second-brain/control/catalog-v2"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BrainSettings } from "../../src/second-brain/settings"
import { OperationOwner } from "../../src/second-brain/operation-owner"
import { ClientV2, settlement } from "../../src/second-brain/client-v2"
import { BrainService } from "../../src/second-brain/service"

type Case = {
  name: string
  selected: { request: string; epoch: string; release: string }
  body: { query?: string; expected_policy_sha256?: string }
  terminal: string
  pending: string
  response: string | null
}
type Fixture = { source_sha256: Record<string, string>; cases: Case[] }
const python = process.env.RAYA_MEMORY_OPERATION_PYTHON
const genuine = python ? test : test.skip
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let memo: Promise<Fixture> | undefined
function fixture() {
  return (memo ??= (async () => {
    if (!python) throw new Error("Pinned pure producer interpreter required")
    expect(digest(await readFile(python))).toBe("b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2")
    const child = Bun.spawn(
      [
        python,
        "-I",
        "-S",
        "-B",
        path.join(import.meta.dir, "fixtures/memory-client-v2-producer.py"),
        path.join(import.meta.dir, "../../script/memory/service"),
        JSON.stringify(release),
      ],
      {
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
      },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, err).toBe(0)
    expect(err).toBe("")
    expect(Buffer.byteLength(out)).toBeLessThan(65536)
    const value = JSON.parse(out)
    expect(value.sourceReviewSHA).toBeNull()
    expect(value.source_sha256).toEqual(release)
    return value as Fixture
  })())
}

async function harness(
  name = "search-completed",
  opts: {
    update?: (value: unknown) => Promise<void>
    get?: () => Promise<void>
    store?: () => Promise<void>
    status?: number
    repeat?: string
    terminal?: (value: string) => Uint8Array
  } = {},
) {
  const data = await fixture()
  const item = data.cases.find((row) => row.name === name)!
  expect(item).toBeDefined()
  const dir = await mkdtemp(path.join(tmpdir(), "raya-memory-v2-owner-"))
  const file = path.join(dir, "state.json")
  const secret = path.join(dir, "synthetic-secret.json")
  await writeFile(file, "{}")
  await writeFile(secret, "{}")
  const settings = new BrainSettings(
    {
      get<T>(key: string) {
        return JSON.parse(readFileSync(file, "utf8"))[key] as T | undefined
      },
      async update(key, value) {
        const state = JSON.parse(await readFile(file, "utf8"))
        if (value === undefined) delete state[key]
        else state[key] = value
        await writeFile(file, JSON.stringify(state))
        await opts.update?.(value)
      },
    },
    {
      async get(key) {
        const value = JSON.parse(await readFile(secret, "utf8"))[key]
        await opts.get?.()
        return value
      },
      async store(key, value) {
        await opts.store?.()
        const state = JSON.parse(await readFile(secret, "utf8"))
        state[key] = value
        await writeFile(secret, JSON.stringify(state))
      },
      async delete(key) {
        const state = JSON.parse(await readFile(secret, "utf8"))
        delete state[key]
        await writeFile(secret, JSON.stringify(state))
      },
    },
  )
  const calls: { method: string; path: string; id: string | null; epoch: string | null }[] = []
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      calls.push({
        method: request.method,
        path: pathname,
        id: request.headers.get("X-Raya-Memory-Request-ID"),
        epoch: request.headers.get("X-Raya-Memory-Owner-Epoch"),
      })
      if (pathname === "/health")
        return Response.json({
          ready: true,
          namespace_valid: true,
          draining: false,
          retirement_pending: false,
          retirement_unconfirmed: false,
          active: 0,
          capture_enabled: false,
          admission_required: true,
          root: "C:\\Synthetic",
          source_sha256: data.source_sha256,
          owner_epoch: item.selected.epoch,
          selected_release_sha256: item.selected.release,
          operation_protocol: "raya.memory.operation.v1",
        })
      expect(request.headers.get("X-Raya-Memory-Owner-Epoch")).toBe(item.selected.epoch)
      expect([item.selected.request, ...(opts.repeat ? [opts.repeat] : [])]).toContain(
        request.headers.get("X-Raya-Memory-Request-ID"),
      )
      if (request.method === "DELETE")
        return Response.json({
          request: item.selected.request,
          owner_epoch: item.selected.epoch,
          retirement_acknowledged: false,
        })
      if (request.method === "GET")
        return new Response(Buffer.from(opts.terminal?.(item.terminal) ?? Buffer.from(item.terminal, "base64")), {
          headers: { "Content-Type": "application/json" },
        })
      expect(JSON.parse(await request.text())).toEqual(item.body)
      return new Response(item.response ? Buffer.from(item.response, "base64") : "{}", {
        status: opts.status ?? 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  const setup = {
    format: "raya.memory.setup",
    version: 2,
    protocol: "raya.memory.operation.v1",
    root: "C:\\Synthetic",
    origin: `http://127.0.0.1:${host.port}`,
    source_sha256: data.source_sha256,
  }
  await settings.save(setup, "synthetic-only")
  const cfg = (await settings.load())!
  const owner = new OperationOwner(settings, cfg.key, cfg.setup)
  async function cleanup() {
    // Failed disposal is asserted by each failure test, not silently converted to success here.
    host.stop(true)
    const target = path.resolve(dir)
    const prefix = path.resolve(tmpdir()) + path.sep
    if (!target.startsWith(prefix) || !path.basename(target).startsWith("raya-memory-v2-owner-"))
      throw new Error("Unsafe fixture cleanup")
    await rm(target, { recursive: true })
  }
  return { item, owner, settings, setup, calls, file, dir, cleanup }
}

genuine("search settles original HTTP selection before exact debt clearance", async () => {
  const value = await harness()
  try {
    expect((await value.settings.load())?.setup.version).toBe(2)
    const rows = await value.owner.search(value.item.body.query!, { id: value.item.selected.request })
    expect(rows.results).toHaveLength(1)
    expect(value.settings.pending()).toBeUndefined()
    expect(value.calls.map((row) => row.method)).toEqual(["GET", "POST", "GET"])
    expect(value.calls[2].path).toContain(value.item.selected.request)
    await value.owner.dispose()
    await expect(value.owner.search("late", { id: "f".repeat(32) })).rejects.toThrow("closed or uncertain")
  } finally {
    await value.cleanup()
  }
})

genuine("stop joins original journal publication and settles never-attempted cancelled debt", async () => {
  const entered = deferred()
  const barrier = deferred()
  const value = await harness("search-completed", {
    async update(input) {
      if (input && typeof input === "object" && "request" in input) {
        entered.resolve()
        await barrier.promise
      }
    },
  })
  const job = value.owner.search(value.item.body.query!, { id: value.item.selected.request })
  try {
    await entered.promise
    expect(value.settings.pending()).toBeDefined()
    await expect(value.owner.search("overlap", { id: "f".repeat(32) })).rejects.toThrow("busy")
    let settled = false
    const stopping = value.owner.stop().finally(() => {
      settled = true
    })
    void stopping.catch(() => undefined)
    await Bun.sleep(10)
    expect(settled).toBe(false)
    await expect(value.owner.search("late after stop", { id: "e".repeat(32) })).rejects.toThrow(
      "busy, closed or uncertain",
    )
    expect(value.calls.map((row) => row.method)).toEqual(["GET"])
    barrier.resolve()
    await expect(job).rejects.toThrow()
    await expect(stopping).rejects.toThrow()
    expect(settled).toBe(true)
    await expect(value.owner.search("late after settlement", { id: "e".repeat(32) })).rejects.toThrow(
      "busy, closed or uncertain",
    )
    expect(value.settings.pending()).toBeUndefined()
    expect((await value.settings.load())?.setup.version).toBe(2)
    expect(value.calls.map((row) => row.path)).toEqual(["/health"])
  } finally {
    barrier.resolve()
    await value.cleanup()
  }
})

genuine("sync holds original external close before clearance and late intake", async () => {
  const value = await harness("sync-completed")
  const entered = deferred()
  const barrier = deferred()
  let count = 0
  const job = value.owner.sync(value.item.body.expected_policy_sha256!, {
    id: value.item.selected.request,
    async close() {
      count++
      await writeFile(path.join(value.dir, "original-close.json"), JSON.stringify({ completed: true }))
      entered.resolve()
      await barrier.promise
    },
  })
  try {
    await entered.promise
    expect(value.settings.pending()).toBeDefined()
    expect(JSON.parse(await readFile(path.join(value.dir, "original-close.json"), "utf8"))).toEqual({ completed: true })
    await expect(value.owner.search("late", { id: "f".repeat(32) })).rejects.toThrow("busy")
    barrier.resolve()
    await job
    expect(count).toBe(1)
    expect(value.settings.pending()).toBeUndefined()
    await value.owner.dispose()
  } finally {
    barrier.resolve()
    await value.cleanup()
  }
})

genuine("failed original close retains debt despite completed operation metadata", async () => {
  const value = await harness("sync-completed")
  const error = new Error("Original close failed")
  try {
    await expect(
      value.owner.sync(value.item.body.expected_policy_sha256!, {
        id: value.item.selected.request,
        async close() {
          throw error
        },
      }),
    ).rejects.toBe(error)
    expect(value.settings.pending()).toBeDefined()
    await expect(value.owner.dispose()).rejects.toBe(error)
    expect(value.calls.map((row) => row.method)).toEqual(["GET", "POST", "GET"])
  } finally {
    await value.cleanup()
  }
})

genuine("completed settlement preserves queued foreign debt and credential replacement", async () => {
  const entered = deferred()
  const release = deferred()
  const storing = deferred()
  const finish = deferred()
  let held = false
  const value = await harness("sync-completed", {
    async store() {
      if (!held) return
      storing.resolve()
      await finish.promise
    },
  })
  const job = value.owner.sync(value.item.body.expected_policy_sha256!, {
    id: value.item.selected.request,
    async close() {
      entered.resolve()
      await release.promise
    },
  })
  try {
    await entered.promise
    const original = value.settings.pending()!
    const replacement = structuredClone(original)
    if (!replacement.request || typeof replacement.request !== "object" || !("id" in replacement.request))
      throw new Error("Actual request debt required")
    replacement.request.id = "f".repeat(32)
    held = true
    const saving = value.settings.save(value.setup, "replacement-synthetic-only")
    await storing.promise
    const changing = value.settings.record(replacement)
    release.resolve()
    await Bun.sleep(10)
    expect(value.settings.pending()).toEqual(original)
    await expect(value.owner.search("late", { id: "e".repeat(32) })).rejects.toThrow("busy")
    finish.resolve()
    await saving
    await changing
    await expect(job).rejects.toThrow("setup or debt changed")
    expect(value.settings.pending()).toEqual(replacement)
    expect(value.owner.retired()).toBe(false)
    await expect(value.owner.dispose()).rejects.toThrow("setup or debt changed")
  } finally {
    release.resolve()
    finish.resolve()
    await value.cleanup()
  }
})

genuine("completed settlement refuses queued foreign debt with unchanged setup", async () => {
  const entered = deferred()
  const release = deferred()
  const writing = deferred()
  const finish = deferred()
  let held = false
  const value = await harness("sync-completed", {
    async update(input) {
      if (!held || !input || typeof input !== "object" || !("request" in input)) return
      writing.resolve()
      await finish.promise
    },
  })
  const job = value.owner.sync(value.item.body.expected_policy_sha256!, {
    id: value.item.selected.request,
    async close() {
      entered.resolve()
      await release.promise
    },
  })
  try {
    await entered.promise
    const replacement = structuredClone(value.settings.pending()!)
    if (!replacement.request || typeof replacement.request !== "object" || !("id" in replacement.request))
      throw new Error("Actual request debt required")
    replacement.request.id = "f".repeat(32)
    held = true
    const changing = value.settings.record(replacement)
    await writing.promise
    release.resolve()
    await Bun.sleep(10)
    await expect(value.owner.search("late", { id: "e".repeat(32) })).rejects.toThrow("busy")
    finish.resolve()
    await changing
    await expect(job).rejects.toThrow("setup or debt changed")
    expect(value.settings.pending()).toEqual(replacement)
    await expect(value.owner.dispose()).rejects.toThrow("setup or debt changed")
  } finally {
    release.resolve()
    finish.resolve()
    await value.cleanup()
  }
})

genuine("completed failed clear cannot restore over an external replacement", async () => {
  const error = new Error("Original clear failed after external replacement")
  let replacement: unknown
  let file = ""
  const value = await harness("search-completed", {
    async update(input) {
      if (input !== undefined) return
      const state = JSON.parse(await readFile(file, "utf8"))
      state["raya.secondBrain.control.uncertainty"] = replacement
      await writeFile(file, JSON.stringify(state))
      throw error
    },
    terminal(input) {
      const state = JSON.parse(readFileSync(file, "utf8"))
      replacement = structuredClone(state["raya.secondBrain.control.uncertainty"])
      ;(replacement as { request: { id: string } }).request.id = "f".repeat(32)
      return Buffer.from(input, "base64")
    },
  })
  file = value.file
  try {
    const result = await value.owner
      .search(value.item.body.query!, { id: value.item.selected.request })
      .catch((err: unknown) => err)
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors[0]).toBe(error)
    expect(value.settings.pending()).toEqual(replacement)
    expect(value.owner.retired()).toBe(false)
    await expect(value.owner.dispose()).rejects.toBe(result)
  } finally {
    await value.cleanup()
  }
})

genuine("completed authority requires original terminal GET and cannot authorize cold debt", async () => {
  const data = await fixture()
  const item = data.cases.find((row) => row.name === "search-completed")!
  let observations = 0
  const value = await harness("search-completed", {
    terminal(input) {
      observations++
      return Buffer.from(observations === 2 ? item.pending : input, "base64")
    },
  })
  try {
    const cfg = (await value.settings.load())!
    const client = new ClientV2(cfg.key, cfg.setup)
    const foreign = new ClientV2(cfg.key, cfg.setup)
    const lease = value.settings.selection(cfg.setup, client)
    await client.search(value.item.body.query!, {
      id: value.item.selected.request,
      async before(request) {
        await value.settings.record(
          {
            format: "raya.memory.control.uncertainty",
            version: 2,
            protocol: value.setup.protocol,
            root: value.setup.root,
            request,
          },
          lease,
        )
      },
    })
    const pending = value.settings.pending()!
    expect(client.completed(value.item.selected.request)).toBeUndefined()
    expect(client.settlement(value.item.selected.request)).toBeUndefined()
    await client.observe(value.item.selected.request)
    const proof = client.completed(value.item.selected.request)!
    expect(proof).toBeDefined()
    await client.observe(value.item.selected.request)
    expect(client.completed(value.item.selected.request)).toBeUndefined()
    await expect(
      client.settle(proof, value.item.selected.request, () => value.settings.settle(pending, lease, proof)),
    ).rejects.toThrow("Original")
    expect(value.settings.pending()).toEqual(pending)
    await client.observe(value.item.selected.request)
    await expect(
      foreign.settle(proof, value.item.selected.request, () => value.settings.settle(pending, lease, proof)),
    ).rejects.toThrow("Original")
    const cold = new BrainSettings(
      {
        get<T>(key: string) {
          return JSON.parse(readFileSync(value.file, "utf8"))[key] as T | undefined
        },
        async update() {
          throw new Error("Cold write must not be reached")
        },
      },
      {
        async get() {
          return "synthetic-only"
        },
        async store() {
          throw new Error("Unused")
        },
        async delete() {
          throw new Error("Unused")
        },
      },
    )
    await expect(
      client.settle(proof, value.item.selected.request, () => cold.settle(pending, lease, proof)),
    ).rejects.toThrow("setup or debt changed")
    expect(cold.pending()).toEqual(pending)
    const fresh = client.completed(value.item.selected.request)!
    await client.settle(fresh, value.item.selected.request, () => value.settings.settle(pending, lease, fresh))
    expect(value.settings.pending()).toBeUndefined()
    expect(client.completed(value.item.selected.request)).toBeUndefined()
    await expect(
      client.settle(fresh, value.item.selected.request, async () => {
        throw new Error("Reused callback")
      }),
    ).rejects.toThrow("Original")
    await value.owner.dispose()
  } finally {
    await value.cleanup()
  }
})

genuine("later attempted failure resets prior completed retirement on the same owner", async () => {
  const id = "f".repeat(32)
  const value = await harness("search-completed", { repeat: id })
  try {
    await value.owner.search(value.item.body.query!, { id: value.item.selected.request })
    expect(value.owner.retired()).toBe(true)
    const job = value.owner.search(value.item.body.query!, { id })
    expect(value.owner.retired()).toBe(false)
    await expect(job).rejects.toThrow()
    expect(value.settings.pending()).toMatchObject({ request: { id } })
    expect(value.owner.retired()).toBe(false)
    await expect(value.owner.dispose()).rejects.toThrow()
    expect(value.calls.filter((row) => row.method === "POST")).toHaveLength(2)
  } finally {
    await value.cleanup()
  }
})

genuine("failed POST retains debt after false cancel ACK and original terminal GET", async () => {
  const value = await harness("search-completed", { status: 499 })
  try {
    await expect(value.owner.search(value.item.body.query!, { id: value.item.selected.request })).rejects.toThrow(
      "Inspect the original",
    )
    expect(value.settings.pending()).toBeDefined()
    expect(value.calls.map((row) => row.method)).toEqual(["GET", "POST", "DELETE", "GET"])
    await expect(value.owner.dispose()).rejects.toThrow("Inspect the original")
  } finally {
    await value.cleanup()
  }
})

genuine("failed clear joins original restoration before releasing its slot", async () => {
  const entered = deferred()
  const barrier = deferred()
  const error = new Error("Clear publication failed")
  let cleared = false
  const value = await harness("search-completed", {
    async update(input) {
      if (input === undefined) {
        cleared = true
        throw error
      }
      if (cleared) {
        entered.resolve()
        await barrier.promise
      }
    },
  })
  const job = value.owner.search(value.item.body.query!, { id: value.item.selected.request })
  try {
    await entered.promise
    expect(value.settings.pending()).toMatchObject({ request: { id: value.item.selected.request } })
    await expect(value.owner.search("late", { id: "f".repeat(32) })).rejects.toThrow("busy")
    barrier.resolve()
    await expect(job).rejects.toBe(error)
    await expect(value.owner.dispose()).rejects.toBe(error)
    expect(value.settings.pending()).toBeDefined()
  } finally {
    barrier.resolve()
    await value.cleanup()
  }
})

genuine("cancel during authorized completed clear joins without recreating retired debt", async () => {
  const entered = deferred()
  const barrier = deferred()
  const value = await harness("search-completed", {
    async update(input) {
      if (input === undefined) {
        entered.resolve()
        await barrier.promise
      }
    },
  })
  const job = value.owner.search(value.item.body.query!, { id: value.item.selected.request })
  try {
    await entered.promise
    let settled = false
    const stopping = value.owner.dispose().finally(() => {
      settled = true
    })
    void stopping.catch(() => undefined)
    await Bun.sleep(10)
    expect(settled).toBe(false)
    barrier.resolve()
    await expect(job).rejects.toThrow()
    await expect(stopping).rejects.toThrow()
    expect(value.settings.pending()).toBeUndefined()
    expect(value.owner.retired()).toBe(true)
  } finally {
    barrier.resolve()
    await value.cleanup()
  }
})

genuine("clear and restoration failures retain both original causes", async () => {
  const primary = new Error("Clear failed")
  const cleanup = new Error("Restoration failed")
  let cleared = false
  const value = await harness("search-completed", {
    async update(input) {
      if (input === undefined) {
        cleared = true
        throw primary
      }
      if (cleared) throw cleanup
    },
  })
  try {
    const result = await value.owner
      .search(value.item.body.query!, { id: value.item.selected.request })
      .catch((error: unknown) => error)
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toEqual([primary, cleanup])
    expect(value.settings.pending()).toBeDefined()
    await expect(value.owner.dispose()).rejects.toBe(result)
  } finally {
    await value.cleanup()
  }
})

genuine("changed original epoch refuses settlement without health adoption", async () => {
  const value = await harness("search-completed", {
    terminal(input) {
      const text = Buffer.from(input, "base64").toString("utf8")
      return Buffer.from(text.replaceAll('"' + "a".repeat(32) + '"', '"' + "b".repeat(32) + '"'))
    },
  })
  try {
    await expect(value.owner.search(value.item.body.query!, { id: value.item.selected.request })).rejects.toThrow()
    expect(value.settings.pending()).toBeDefined()
    expect(value.calls.map((row) => row.method)).toEqual(["GET", "POST", "GET"])
    await expect(value.owner.dispose()).rejects.toThrow()
  } finally {
    await value.cleanup()
  }
})

genuine("body and original close failures remain distinct through disposal", async () => {
  const value = await harness("sync-completed", { status: 499 })
  const cleanup = new Error("Original local close failed")
  try {
    const result = await value.owner
      .sync(value.item.body.expected_policy_sha256!, {
        id: value.item.selected.request,
        async close() {
          throw cleanup
        },
      })
      .catch((error: unknown) => error)
    expect(result).toBeInstanceOf(AggregateError)
    const errors = (result as AggregateError).errors
    expect(errors).toHaveLength(2)
    expect(errors[0].code).toBe("service_error")
    expect(errors[1]).toBe(cleanup)
    expect(value.settings.pending()).toBeDefined()
    expect(value.calls.map((row) => row.method)).toEqual(["GET", "POST", "DELETE", "GET"])
    await expect(value.owner.dispose()).rejects.toBe(result)
  } finally {
    await value.cleanup()
  }
})

genuine("genuine pending metadata cannot clear completed response debt", async () => {
  const data = await fixture()
  const item = data.cases.find((row) => row.name === "search-completed")!
  const value = await harness("search-completed", {
    terminal() {
      return Buffer.from(item.pending, "base64")
    },
  })
  try {
    await expect(value.owner.search(value.item.body.query!, { id: value.item.selected.request })).rejects.toThrow(
      "not completed",
    )
    expect(value.settings.pending()).toBeDefined()
    expect(value.calls.map((row) => row.method)).toEqual(["GET", "POST", "GET"])
    await expect(value.owner.dispose()).rejects.toThrow("not completed")
  } finally {
    await value.cleanup()
  }
})

genuine("pure validation refuses before slot reservation and original HTTP", async () => {
  const value = await harness()
  try {
    await expect(value.owner.search("", { id: "f".repeat(32) })).rejects.toThrow("bounded")
    await expect(value.owner.search("valid", { id: "F".repeat(32) })).rejects.toThrow("Fresh internal")
    expect(value.calls).toHaveLength(0)
    expect(value.settings.pending()).toBeUndefined()
    await value.owner.search(value.item.body.query!, { id: value.item.selected.request })
    await value.owner.dispose()
  } finally {
    await value.cleanup()
  }
})

genuine("idle stop synchronously fences generation before its promise settles", async () => {
  const value = await harness()
  try {
    const stopping = value.owner.stop()
    await expect(value.owner.search(value.item.body.query!, { id: value.item.selected.request })).rejects.toThrow(
      "closed or uncertain",
    )
    await stopping
    expect(value.calls).toHaveLength(0)
    expect(value.settings.pending()).toBeUndefined()
    await value.owner.dispose()
  } finally {
    await value.cleanup()
  }
})

genuine("never-attempted sync waits for original native close before clearing cancelled debt", async () => {
  const entered = deferred()
  const before = deferred()
  const closing = deferred()
  const release = deferred()
  const value = await harness("sync-completed", {
    async update(input) {
      if (input && typeof input === "object" && "request" in input) {
        entered.resolve()
        await before.promise
      }
    },
  })
  const job = value.owner.sync(value.item.body.expected_policy_sha256!, {
    id: value.item.selected.request,
    async close() {
      await writeFile(path.join(value.dir, "original-close.json"), "closed")
      closing.resolve()
      await release.promise
    },
  })
  try {
    await entered.promise
    const stopping = value.owner.stop()
    void stopping.catch(() => undefined)
    before.resolve()
    await closing.promise
    expect(value.settings.pending()).toBeDefined()
    expect(await readFile(path.join(value.dir, "original-close.json"), "utf8")).toBe("closed")
    expect(value.calls.map((row) => row.path)).toEqual(["/health"])
    release.resolve()
    await expect(job).rejects.toThrow()
    await expect(stopping).rejects.toThrow()
    expect(value.settings.pending()).toBeUndefined()
  } finally {
    before.resolve()
    release.resolve()
    await value.cleanup()
  }
})

genuine("never-attempted cancellation retains debt on original close failure", async () => {
  const entered = deferred()
  const release = deferred()
  const error = new Error("Original native close failed")
  const value = await harness("sync-completed", {
    async update(input) {
      if (input && typeof input === "object" && "request" in input) {
        entered.resolve()
        await release.promise
      }
    },
  })
  const job = value.owner.sync(value.item.body.expected_policy_sha256!, {
    id: value.item.selected.request,
    async close() {
      throw error
    },
  })
  try {
    await entered.promise
    const stopping = value.owner.stop()
    void stopping.catch(() => undefined)
    release.resolve()
    const result = await job.catch((err: unknown) => err)
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toContain(error)
    await expect(stopping).rejects.toBe(result)
    expect(value.settings.pending()).toBeDefined()
    expect(value.calls.map((row) => row.path)).toEqual(["/health"])
  } finally {
    release.resolve()
    await value.cleanup()
  }
})

genuine("serialized never-attempted settlement refuses replacement of the same setup credential", async () => {
  const entered = deferred()
  const release = deferred()
  const value = await harness("search-completed", {
    async update(input) {
      if (input && typeof input === "object" && "request" in input) {
        entered.resolve()
        await release.promise
      }
    },
  })
  const job = value.owner.search(value.item.body.query!, { id: value.item.selected.request })
  try {
    await entered.promise
    const stopping = value.owner.stop()
    void stopping.catch(() => undefined)
    const replacement = value.settings.save(value.setup, "replacement-synthetic-only")
    release.resolve()
    await replacement
    await expect(job).rejects.toThrow()
    await expect(stopping).rejects.toThrow()
    expect(value.settings.pending()).toBeDefined()
    expect(value.calls.map((row) => row.path)).toEqual(["/health"])
  } finally {
    release.resolve()
    await value.cleanup()
  }
})

genuine("never-attempted proof cannot be fabricated, transferred between clients, or reused", async () => {
  const value = await harness()
  const client = new ClientV2("synthetic-only", value.setup)
  const foreign = new ClientV2("synthetic-only", value.setup)
  const entered = deferred()
  const release = deferred()
  const controller = new AbortController()
  let invoked = 0
  let request: unknown
  const job = client.search(value.item.body.query!, {
    id: value.item.selected.request,
    signal: controller.signal,
    async before(input) {
      request = input
      entered.resolve()
      await release.promise
    },
  })
  try {
    await entered.promise
    expect(client.settlement(value.item.selected.request)).toBeUndefined()
    await expect(
      client.settle({}, value.item.selected.request, async () => {
        invoked++
      }),
    ).rejects.toThrow("Original")
    controller.abort()
    release.resolve()
    await expect(job).rejects.toThrow()
    const proof = client.settlement(value.item.selected.request)!
    expect(proof).toBeDefined()
    expect(settlement(proof, value.setup, request, client)).toBe(false)
    await expect(
      foreign.settle(proof, value.item.selected.request, async () => {
        invoked++
      }),
    ).rejects.toThrow("Original")
    await client.settle(proof, value.item.selected.request, async () => {
      expect(settlement(proof, value.setup, request, client)).toBe(true)
      expect(settlement(proof, value.setup, {}, client)).toBe(false)
      expect(Reflect.apply(settlement, undefined, [proof, value.setup, request, undefined])).toBe(false)
      invoked++
    })
    expect(settlement(proof, value.setup, request, client)).toBe(false)
    await expect(
      client.settle(proof, value.item.selected.request, async () => {
        invoked++
      }),
    ).rejects.toThrow("Original")
    expect(invoked).toBe(1)
    expect(value.calls.map((row) => row.path)).toEqual(["/health"])
    await value.owner.dispose()
  } finally {
    release.resolve()
    await value.cleanup()
  }
})

genuine("never-attempted journal failure refuses proof and retains original debt", async () => {
  const error = new Error("Original journal failed")
  const value = await harness("search-completed", {
    async update(input) {
      if (input && typeof input === "object" && "request" in input) throw error
    },
  })
  try {
    const result = await value.owner
      .search(value.item.body.query!, { id: value.item.selected.request })
      .catch((err: unknown) => err)
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toContain(error)
    expect(value.settings.pending()).toBeDefined()
    expect(value.calls.map((row) => row.path)).toEqual(["/health"])
    await expect(value.owner.dispose()).rejects.toBe(result)
  } finally {
    await value.cleanup()
  }
})

genuine("usable fresh service generation follows joined never-attempted cancellation", async () => {
  const entered = deferred()
  const release = deferred()
  const value = await harness("search-completed", {
    async update(input) {
      if (input && typeof input === "object" && "request" in input) {
        entered.resolve()
        await release.promise
      }
    },
  })
  const service = new BrainService(value.settings)
  const states: string[] = []
  const job = service.run(value.item.body.query!, (state) => states.push(state.status))
  try {
    await entered.promise
    const stopping = service.stop()
    void stopping.catch(() => undefined)
    release.resolve()
    await expect(job).rejects.toThrow()
    await expect(stopping).rejects.toThrow()
    expect(states.at(-1)).toBe("cancelled")
    expect(value.settings.pending()).toBeUndefined()
    await service.run(undefined, (state) => states.push(state.status))
    expect(states.at(-1)).toBe("ready")
    expect(value.calls.map((row) => row.path)).toEqual(["/health", "/health"])
    await service.dispose()
    await value.owner.dispose()
  } finally {
    release.resolve()
    await value.cleanup()
  }
})

genuine("failed never-attempted clear joins restoration and retains cancellation and write failures", async () => {
  const entered = deferred()
  const release = deferred()
  const restoring = deferred()
  const finish = deferred()
  const error = new Error("Never-attempted clear failed")
  let failed = false
  const value = await harness("search-completed", {
    async update(input) {
      if (input === undefined) {
        failed = true
        throw error
      }
      if (failed) {
        restoring.resolve()
        await finish.promise
        return
      }
      if (input && typeof input === "object" && "request" in input) {
        entered.resolve()
        await release.promise
      }
    },
  })
  const job = value.owner.search(value.item.body.query!, { id: value.item.selected.request })
  try {
    await entered.promise
    const stopping = value.owner.stop()
    void stopping.catch(() => undefined)
    release.resolve()
    await restoring.promise
    expect(value.settings.pending()).toBeDefined()
    expect(value.owner.retired()).toBe(false)
    finish.resolve()
    const result = await job.catch((err: unknown) => err)
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toContain(error)
    await expect(stopping).rejects.toBe(result)
    expect(value.settings.pending()).toBeDefined()
    expect(value.calls.map((row) => row.path)).toEqual(["/health"])
  } finally {
    release.resolve()
    finish.resolve()
    await value.cleanup()
  }
})

genuine("serialized never-attempted settlement preserves a queued replacement debt", async () => {
  const entered = deferred()
  const release = deferred()
  let held = false
  const value = await harness("search-completed", {
    async update(input) {
      if (input && typeof input === "object" && "request" in input && !held) {
        held = true
        entered.resolve()
        await release.promise
      }
    },
  })
  const job = value.owner.search(value.item.body.query!, { id: value.item.selected.request })
  try {
    await entered.promise
    const original = value.settings.pending()!
    const replacement = structuredClone(original)
    if (!replacement.request || typeof replacement.request !== "object" || !("id" in replacement.request))
      throw new Error("Actual request debt required")
    replacement.request.id = "f".repeat(32)
    const changing = value.settings.record(replacement)
    const stopping = value.owner.stop()
    void stopping.catch(() => undefined)
    release.resolve()
    await changing
    await expect(job).rejects.toThrow()
    await expect(stopping).rejects.toThrow()
    expect(value.settings.pending()).toEqual(replacement)
    expect(value.owner.retired()).toBe(false)
    expect(value.calls.map((row) => row.path)).toEqual(["/health"])
  } finally {
    release.resolve()
    await value.cleanup()
  }
})

genuine("never-attempted failed clear and restoration preserve both persistence causes", async () => {
  const entered = deferred()
  const release = deferred()
  const primary = new Error("Clear failed")
  const cleanup = new Error("Restore failed")
  let failed = false
  const value = await harness("search-completed", {
    async update(input) {
      if (input === undefined) {
        failed = true
        throw primary
      }
      if (failed) throw cleanup
      if (input && typeof input === "object" && "request" in input) {
        entered.resolve()
        await release.promise
      }
    },
  })
  const job = value.owner.search(value.item.body.query!, { id: value.item.selected.request })
  try {
    await entered.promise
    const stopping = value.owner.stop()
    void stopping.catch(() => undefined)
    release.resolve()
    const result = await job.catch((err: unknown) => err)
    expect(result).toBeInstanceOf(AggregateError)
    const retained = (result as AggregateError).errors.find((err: unknown) => err instanceof AggregateError)
    expect(retained).toBeInstanceOf(AggregateError)
    expect((retained as AggregateError).errors).toEqual([primary, cleanup])
    await expect(stopping).rejects.toBe(result)
    expect(value.settings.pending()).toBeDefined()
    expect(value.owner.retired()).toBe(false)
    expect(value.calls.map((row) => row.path)).toEqual(["/health"])
  } finally {
    release.resolve()
    await value.cleanup()
  }
})

genuine("loaded credential lease refuses replacement before owner construction", async () => {
  const value = await harness()
  try {
    const cfg = (await value.settings.load())!
    expect(() => Reflect.apply(value.settings.selection, value.settings, [cfg.setup, undefined])).toThrow(
      "Original loaded",
    )
    expect(() => new OperationOwner(value.settings, cfg.key, structuredClone(cfg.setup))).toThrow("Original loaded")
    await value.settings.save(value.setup, "replacement-synthetic-only")
    expect(() => new OperationOwner(value.settings, cfg.key, cfg.setup)).toThrow("Original loaded")
    const fresh = (await value.settings.load())!
    const owner = new OperationOwner(value.settings, fresh.key, fresh.setup)
    await owner.dispose()
    expect(value.calls).toEqual([])
  } finally {
    await value.cleanup()
  }
})

genuine("credential replacement while original load is held refuses the original selection", async () => {
  const entered = deferred()
  const release = deferred()
  let held = false
  const value = await harness("search-completed", {
    async get() {
      if (!held) return
      entered.resolve()
      await release.promise
    },
  })
  try {
    held = true
    const loading = value.settings.load()
    await entered.promise
    await value.settings.save(value.setup, "replacement-synthetic-only")
    release.resolve()
    await expect(loading).rejects.toThrow("selection changed during load")
    expect(value.calls).toEqual([])
  } finally {
    release.resolve()
    await value.cleanup()
  }
})

genuine("serialized settings cannot clear genuine debt with fabricated settlement authority", async () => {
  const value = await harness()
  try {
    const cfg = (await value.settings.load())!
    const client = new ClientV2(cfg.key, cfg.setup)
    const lease = value.settings.selection(cfg.setup, client)
    const controller = new AbortController()
    await expect(
      client.search(value.item.body.query!, {
        id: value.item.selected.request,
        signal: controller.signal,
        async before(request) {
          await value.settings.record({
            format: "raya.memory.control.uncertainty",
            version: 2,
            protocol: value.setup.protocol,
            root: value.setup.root,
            request,
          })
          controller.abort()
        },
      }),
    ).rejects.toThrow()
    const pending = value.settings.pending()!
    await expect(value.settings.settle(pending, lease, {})).rejects.toThrow("setup or debt changed")
    const proof = client.settlement(value.item.selected.request)!
    expect(proof).toBeDefined()
    await expect(
      client.settle(proof, value.item.selected.request, () => value.settings.settle(pending, lease, proof)),
    ).rejects.toThrow("setup or debt changed")
    expect(value.settings.pending()).toEqual(pending)
    expect(value.calls.map((row) => row.path)).toEqual(["/health"])
  } finally {
    await value.cleanup()
  }
})

genuine("debt published while original credential load is held fences returned setup", async () => {
  const entered = deferred()
  const release = deferred()
  let held = false
  const value = await harness("search-completed", {
    async get() {
      if (!held) return
      entered.resolve()
      await release.promise
    },
  })
  try {
    const cfg = (await value.settings.load())!
    const client = new ClientV2(cfg.key, cfg.setup)
    const controller = new AbortController()
    held = true
    const loading = value.settings.load()
    await entered.promise
    await expect(
      client.search(value.item.body.query!, {
        id: value.item.selected.request,
        signal: controller.signal,
        async before(request) {
          await value.settings.record({
            format: "raya.memory.control.uncertainty",
            version: 2,
            protocol: value.setup.protocol,
            root: value.setup.root,
            request,
          })
          controller.abort()
        },
      }),
    ).rejects.toThrow()
    const pending = value.settings.pending()
    expect(pending).toBeDefined()
    release.resolve()
    await expect(loading).rejects.toThrow("pending original settlement")
    expect(value.settings.pending()).toEqual(pending)
    expect(value.calls.map((row) => row.path)).toEqual(["/health"])
  } finally {
    release.resolve()
    await value.cleanup()
  }
})

genuine("equivalent never-attempted client cannot settle original attempted debt", async () => {
  const value = await harness("search-completed", { status: 499 })
  try {
    const cfg = (await value.settings.load())!
    const other = (await value.settings.load())!
    const original = new ClientV2(cfg.key, cfg.setup)
    const foreign = new ClientV2(other.key, other.setup)
    const lease = value.settings.selection(cfg.setup, original)
    const replacement = value.settings.selection(other.setup, foreign)
    await expect(
      original.search(value.item.body.query!, {
        id: value.item.selected.request,
        async before(request) {
          await value.settings.record(
            {
              format: "raya.memory.control.uncertainty",
              version: 2,
              protocol: value.setup.protocol,
              root: value.setup.root,
              request,
            },
            lease,
          )
        },
      }),
    ).rejects.toThrow()
    const pending = value.settings.pending()!
    expect(pending).toBeDefined()
    expect(original.settlement(value.item.selected.request)).toBeUndefined()
    await expect(value.settings.record(pending, replacement)).rejects.toThrow("unchanged empty slot")
    expect(value.settings.pending()).toEqual(pending)
    const controller = new AbortController()
    await expect(
      foreign.search(value.item.body.query!, {
        id: value.item.selected.request,
        signal: controller.signal,
        async before(request) {
          expect(request).toEqual(pending.request)
          controller.abort()
        },
      }),
    ).rejects.toThrow()
    const proof = foreign.settlement(value.item.selected.request)!
    expect(proof).toBeDefined()
    await expect(
      foreign.settle(proof, value.item.selected.request, () => value.settings.settle(pending, lease, proof)),
    ).rejects.toThrow("setup or debt changed")
    const second = foreign.settlement(value.item.selected.request)!
    await expect(
      foreign.settle(second, value.item.selected.request, () => value.settings.settle(pending, replacement, second)),
    ).rejects.toThrow("setup or debt changed")
    expect(value.settings.pending()).toEqual(pending)
    expect(value.calls.map((row) => [row.method, row.path])).toEqual([
      ["GET", "/health"],
      ["POST", "/v1/memory/search"],
      ["GET", "/health"],
    ])
  } finally {
    await value.cleanup()
  }
})

genuine("native sync cancellation releases only its joined never-attempted service generation", async () => {
  const entered = deferred()
  const release = deferred()
  const closing = deferred()
  const finish = deferred()
  const value = await harness("sync-completed", {
    async update(input) {
      if (input && typeof input === "object" && "request" in input) {
        entered.resolve()
        await release.promise
      }
    },
  })
  const service = new BrainService(value.settings)
  const controller = new AbortController()
  const job = service.configure(
    () =>
      service.sync(value.item.body.expected_policy_sha256!, controller.signal, async () => {
        closing.resolve()
        await finish.promise
      }),
    false,
  )
  try {
    await entered.promise
    controller.abort()
    release.resolve()
    await closing.promise
    expect(value.settings.pending()).toBeDefined()
    finish.resolve()
    await expect(job).rejects.toThrow()
    expect(value.settings.pending()).toBeUndefined()
    const states: string[] = []
    await service.run(undefined, (state) => states.push(state.status))
    expect(states.at(-1)).toBe("ready")
    expect(value.calls.map((row) => row.path)).toEqual(["/health", "/health"])
    await service.dispose()
  } finally {
    release.resolve()
    finish.resolve()
    await value.cleanup()
  }
})
