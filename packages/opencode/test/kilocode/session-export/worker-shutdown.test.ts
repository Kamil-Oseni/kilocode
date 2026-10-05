import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmRequestStarted } from "@/kilocode/session-export/events"
import type { FromWorker } from "@/kilocode/session-export/worker/ipc"
import { Storage } from "@/kilocode/session-export/worker/storage"
import { parseMessage } from "@/kilocode/session-export/worker/validate"
import { stopExportWorker } from "@/kilocode/session-export/worker-stop"
import * as Identity from "@/kilocode/session-export/worker-identity"
import { Database } from "bun:sqlite"
import { profileSqlite } from "@opencode-ai/core/kilocode/profile-sqlite"

test("shutdown requires a correlated request identity", () => {
  const expected = Identity.request(Identity.spawn(crypto.randomUUID()))
  expect(parseMessage({ kind: "shutdown", timeoutMs: 1000 })).toBeUndefined()
  expect(parseMessage({ kind: "shutdown", timeoutMs: 1000, requestID: "" })).toBeUndefined()
  expect(parseMessage({ kind: "shutdown", timeoutMs: 1000, ...expected })).toEqual({
    kind: "shutdown",
    timeoutMs: 1000,
    ...expected,
  })
})

test("real worker joins event persistence before confirmed shutdown and fences late intake", async () => {
  const owner = Identity.spawn(crypto.randomUUID())
  const request = Identity.request(owner)
  const dir = mkdtempSync(join(tmpdir(), "raya-export-shutdown-"))
  const file = join(dir, "session-export.db")
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1
      return new Response("later", { status: 503 })
    },
  })
  const worker = new Worker(new URL("../../../src/kilocode/session-export/worker.ts", import.meta.url))
  const messages: FromWorker[] = []
  let closed = false
  worker.addEventListener("close", (event) => {
    closed = true
    expect("code" in event && event.code).toBe(0)
    expect("wasClean" in event && event.wasClean).toBe(true)
  })
  worker.onmessage = (event: MessageEvent<FromWorker>) => messages.push(event.data)
  try {
    worker.postMessage({
      kind: "init",
      identity: owner,
      dbPath: file,
      endpoint: `http://127.0.0.1:${server.port}`,
      allowCustomEndpoint: true,
      agentVersion: "test",
      surface: "test",
    })
    await until(() => messages.some((message) => message.kind === "ready"))
    for (const seq of Array.from({ length: 80 }, (_, index) => index)) {
      worker.postMessage({ kind: "event", envelope: started(seq), approxBytes: 512 })
    }
    const stopping = stopExportWorker(worker, request, 10_000)
    await Promise.resolve()
    worker.postMessage({ kind: "shutdown", timeoutMs: 10_000, ...request })
    worker.postMessage({ kind: "event", envelope: started(80), approxBytes: 512 })
    worker.postMessage({ kind: "test_event_count" })
    await stopping
    expect(closed).toBe(true)
    expect(messages.filter((message) => message.kind === "shutdown_done")).toHaveLength(1)
    expect(messages.find((message) => message.kind === "shutdown_done" || message.kind === "shutdown_refused")).toEqual(
      await stopping,
    )
    const storage = new Storage(file)
    try {
      const rows = storage.pendingEvents({ now: 1_000_000_000_000_000, limitBytes: 10_000_000 })
      expect(rows).toHaveLength(80)
      expect(rows.map((row) => row.id).sort()).toEqual(
        Array.from({ length: 80 }, (_, index) => `export-${index}`).sort(),
      )
    } finally {
      storage.close()
    }
  } finally {
    if (!closed) worker.terminate()
    await server.stop(true)
    await remove(dir)
  }
}, 30_000)

test("production worker cannot acknowledge or exit before a real held upload settles", async () => {
  const owner = Identity.spawn(crypto.randomUUID())
  const request = Identity.request(owner)
  const dir = mkdtempSync(join(tmpdir(), "raya-export-held-natural-exit-"))
  const file = join(dir, "session-export.db")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    async fetch() {
      entered.resolve()
      await release.promise
      return new Response("later", { status: 503 })
    },
  })
  const worker = new Worker(new URL("../../../src/kilocode/session-export/worker.ts", import.meta.url))
  const ready = Promise.withResolvers<void>()
  const messages: FromWorker[] = []
  let closed = false
  worker.addEventListener("close", () => {
    closed = true
  })
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    messages.push(event.data)
    if (event.data.kind === "ready") ready.resolve()
  }
  const timer = setTimeout(() => release.resolve(), 10_000)
  try {
    worker.postMessage({
      kind: "init",
      identity: owner,
      dbPath: file,
      endpoint: `http://127.0.0.1:${server.port}`,
      allowCustomEndpoint: true,
    })
    await ready.promise
    worker.postMessage({ kind: "event", envelope: started(0), approxBytes: 512 })
    await entered.promise
    let settled = false
    const pending = stopExportWorker(worker, request, 10_000).then(() => {
      settled = true
    })
    await Promise.resolve()
    worker.postMessage({ kind: "shutdown", timeoutMs: 1000, ...request })
    const other = Identity.request(owner)
    worker.postMessage({ kind: "shutdown", timeoutMs: 1000, ...other })
    await until(() => messages.some((msg) => msg.kind === "shutdown_refused" && msg.requestID === other.requestID))
    expect(settled).toBe(false)
    expect(closed).toBe(false)
    release.resolve()
    await pending
    expect(closed).toBe(true)
    expect(messages.filter((msg) => msg.kind === "shutdown_done")).toHaveLength(1)
    const store = new Storage(file)
    try {
      expect(store.pendingEvents({ now: 1_000_000_000_000_000, limitBytes: 10_000_000 })).toHaveLength(1)
    } finally {
      store.close()
    }
  } finally {
    clearTimeout(timer)
    release.resolve()
    if (!closed) worker.terminate()
    await server.stop(true)
    await remove(dir)
  }
}, 20_000)

test("real worker retains failed batch evidence and refuses shutdown confirmation", async () => {
  const owner = Identity.spawn(crypto.randomUUID())
  const request = Identity.request(owner)
  const dir = mkdtempSync(join(tmpdir(), "raya-export-failed-batch-"))
  const file = join(dir, "session-export.db")
  const server = Bun.serve({ port: 0, fetch: () => new Response("later", { status: 503 }) })
  const worker = new Worker(new URL("../../../src/kilocode/session-export/worker.ts", import.meta.url))
  const messages: FromWorker[] = []
  worker.onmessage = (event: MessageEvent<FromWorker>) => messages.push(event.data)
  try {
    worker.postMessage({
      kind: "init",
      identity: owner,
      dbPath: file,
      endpoint: `http://127.0.0.1:${server.port}`,
      allowCustomEndpoint: true,
      agentVersion: "test",
      surface: "test",
    })
    await until(() => messages.some((message) => message.kind === "ready"))
    worker.postMessage({ kind: "event", envelope: started(0), approxBytes: 512 })
    worker.postMessage({ kind: "event", envelope: started(0), approxBytes: 512 })
    worker.postMessage({ kind: "shutdown", timeoutMs: 10_000, ...request })
    await until(() => messages.some((message) => message.kind === "shutdown_refused"))
    expect(messages.find((message) => message.kind === "shutdown_refused")).toEqual({
      kind: "shutdown_refused",
      ...request,
      reason: "event-persistence-failed",
      failures: ["Session export event persistence failed"],
    })
    expect(messages.some((message) => message.kind === "shutdown_done")).toBe(false)
    const failure = messages.find(
      (message) => message.kind === "telemetry" && message.name === "session_export.handler_error",
    )
    expect(failure?.kind === "telemetry" ? failure.props : undefined).toMatchObject({
      retainedEvents: 1,
      queuedBytes: 512,
    })
    const store = new Storage(file)
    try {
      expect(store.pendingEvents({ now: 1_000_000_000_000_000, limitBytes: 10_000_000 }).map((row) => row.id)).toEqual([
        "export-0",
      ])
    } finally {
      store.close()
    }
  } finally {
    worker.terminate()
    await server.stop(true)
    await remove(dir)
  }
}, 30_000)

test("production worker pins init identity, refuses unrelated shutdowns before cleanup, and observes only local roots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raya-export-pinned-identity-"))
  const file = join(dir, "session-export.db")
  const unused = join(dir, "unselected.db")
  const owner = Identity.spawn(crypto.randomUUID())
  const worker = new Worker(new URL("../../../src/kilocode/session-export/worker.ts", import.meta.url))
  const messages: FromWorker[] = []
  let closed = false
  worker.addEventListener("close", () => {
    closed = true
  })
  worker.onmessage = (event: MessageEvent<FromWorker>) => messages.push(event.data)
  try {
    worker.postMessage({ kind: "init", dbPath: file, identity: owner })
    await until(() => messages.some((msg) => msg.kind === "ready"))
    worker.postMessage({ kind: "init", dbPath: unused, identity: Identity.spawn(crypto.randomUUID()) })
    await until(() =>
      messages.some((msg) => msg.kind === "telemetry" && msg.name === "session_export.init_identity_already_pinned"),
    )
    expect(await Bun.file(unused).exists()).toBe(false)
    for (const changed of [
      { ...owner, runID: crypto.randomUUID() },
      { ...owner, generation: crypto.randomUUID() },
    ]) {
      const request = Identity.request(changed)
      worker.postMessage({ kind: "shutdown", timeoutMs: 1000, ...request })
      await until(() => messages.some((msg) => msg.kind === "shutdown_refused" && msg.requestID === request.requestID))
    }
    expect(closed).toBe(false)
    expect(messages.filter((msg) => msg.kind === "ready")).toHaveLength(1)
    const peer = profileSqlite(file, () => new Database(file))
    try {
      const reply = await stopExportWorker(worker, Identity.request(owner), 5000)
      expect(reply.receipt.roots).toEqual([
        { kind: "json", path: dir },
        { kind: "sqlite", path: file },
      ])
      expect(reply.scopes).toEqual({ version: 2, states: [], globals: [] })
      expect(reply.receipt.processLocal).toBe(true)
      expect("nativeOwners" in reply.receipt).toBe(false)
      expect("operations" in reply.receipt).toBe(false)
      expect(peer.query("SELECT COUNT(*) AS count FROM event").get()).toEqual({ count: 0 })
      expect(closed).toBe(true)
    } finally {
      peer.close()
    }
  } finally {
    if (!closed) worker.terminate()
    await remove(dir)
  }
}, 15_000)

function started(seq: number): LlmRequestStarted {
  return {
    id: `export-${seq}`,
    schemaVersion: 1,
    type: "llm_request_started",
    sessionId: "s1",
    rootSessionId: "s1",
    seq,
    ts: 100 + seq,
    agentVersion: "test",
    requestId: `r-${seq}`,
    userMessageId: `u-${seq}`,
    agent: "build",
    modeId: "build",
    model: { providerId: "kilo", modelId: "free-1", isFree: true },
    input: { system: [], messages: [], tools: {}, permissions: [], params: {} },
    time: { created: 0 },
  }
}

async function until(check: () => boolean, details?: () => unknown): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 15_000) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for worker acknowledgement: ${JSON.stringify(details?.())}`)
}

async function remove(dir: string): Promise<void> {
  const stop = performance.now() + 5000
  while (true) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (!err || typeof err !== "object" || !("code" in err) || err.code !== "EBUSY" || performance.now() >= stop)
        throw err
      await Bun.sleep(100)
    }
  }
}
