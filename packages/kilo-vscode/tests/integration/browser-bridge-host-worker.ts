import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createKiloClient, type GlobalEvent } from "@kilocode/sdk/v2/client"
import { BrowserBridge, type BrowserConnection } from "../../src/services/browser-automation/browser-bridge"
import { BrowserSession } from "../../src/services/browser-automation/browser-session"
import { normalize, type SSEEventHandler } from "../../src/services/cli-backend/sdk-sse-adapter"
import { categories, ComputerUseLeaseStore, type SensitivePolicy } from "../../src/services/computer-use/lease-store"

const cfg = JSON.parse(process.env.RAYA_HOST_CONFIG ?? "null") as {
  phase: number
  url: string
  project: string
  root: string
  password: string
}
assert.ok(cfg && [1, 2].includes(cfg.phase) && cfg.url.startsWith("http://127.0.0.1:"))
const file = join(cfg.root, "state.json")
const saved = (() => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {}
    throw err
  }
})()
const restored = saved["raya.computerUse.browser.failureReceipts.v1"]
const disk = { writes: Promise.resolve() }
const storage = {
  get: <T>(key: string) => saved[key] as T | undefined,
  update: async (key: string, value: unknown) => {
    saved[key] = value
    const data = JSON.stringify(saved)
    disk.writes = disk.writes.then(async () => {
      const temp = `${file}.${process.pid}.tmp`
      await writeFile(temp, data)
      await rename(temp, file)
    })
    await disk.writes
  },
}
const lease = new ComputerUseLeaseStore(storage)
const browser = new BrowserSession(join(cfg.root, `profile-${cfg.phase}`), undefined, join(cfg.root, "artifacts"), {
  profileID: `host-${cfg.phase}`,
  directory: cfg.project,
})
const stopped = new AbortController()
const handlers = new Set<SSEEventHandler>()
const states = new Set<(state: "connected" | "disconnected") => void>()
const stats = { actions: [] as string[], drop: false, ack: "", proof: undefined as unknown, request: "" }
const client = createKiloClient({
  baseUrl: cfg.url,
  directory: cfg.project,
  headers: { Authorization: `Basic ${Buffer.from(`kilo:${cfg.password}`).toString("base64")}` },
  fetch: async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const ack =
      cfg.phase === 1 && path.endsWith("/acknowledge") && input instanceof Request
        ? input
            .clone()
            .json()
            .catch((err: unknown) => {
              process.send?.({ phase: "fetch-fault", pid: process.pid, error: String(err) })
              throw err
            })
        : undefined
    if (path.endsWith("/acknowledge"))
      process.send?.({ phase: "ack-seen", pid: process.pid, path, request: stats.request })
    const deadlines = path === "/global/event" ? [] : [AbortSignal.timeout(35_000)]
    const response = await fetch(input, {
      ...init,
      signal: AbortSignal.any([stopped.signal, ...(signal ? [signal] : []), ...deadlines]),
    })
    if (cfg.phase === 1 && !stats.drop && stats.request && path === `/kilocode/browser/${stats.request}/acknowledge`) {
      assert.equal(response.status, 200, "The backend must accept the exact ACK before its response is lost")
      const body = (await ack) as { proof: unknown; ack: string } | undefined
      assert.ok(body?.proof && body.ack)
      stats.drop = true
      stats.proof = body.proof
      stats.ack = body.ack
      process.send?.({ phase: "dropped", pid: process.pid, request: stats.request, proof: stats.proof, ack: stats.ack })
      return new Promise<Response>(() => {})
    }
    return response
  },
})
const connection: BrowserConnection = {
  getClient: () => client,
  getKnownDirectories: () => [cfg.project],
  onEvent: (handler) => {
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  },
  onStateChange: (handler) => {
    states.add(handler)
    return () => {
      states.delete(handler)
    }
  },
}
const bridge = new BrowserBridge(
  connection,
  {
    show: async (directory) => {
      assert.equal(directory, cfg.project)
    },
    execute: async (action) => {
      assert.equal(action.origin?.directory, cfg.project)
      stats.actions.push(action.operation)
      process.send?.({ phase: "action", pid: process.pid, operation: action.operation })
      return browser.execute(action)
    },
    cancel: () => browser.takeControl("Owned host stopped"),
    uncertain: (_directory, reason) => browser.takeControl(reason),
  },
  storage,
  async (request) => lease.authorize(request),
  (request) => lease.authorize(request),
)
const connected = Promise.withResolvers<void>()
const stream = (async () => {
  const response = await client.global.event({ signal: stopped.signal, sseMaxRetryAttempts: 1 })
  for await (const value of response.stream as AsyncGenerator<GlobalEvent>) {
    const event = normalize(value.payload)
    if (event.type === "server.connected") {
      for (const state of states) state("connected")
      connected.resolve()
    }
    for (const handler of handlers) handler(event, value.directory)
    if (event.type === "kilocode.browser.requested" && event.properties.operation === "click") {
      stats.request = event.properties.id
      process.send?.({ phase: "click-request", pid: process.pid, request: stats.request })
    }
  }
})().catch((err: unknown) => {
  if (!stopped.signal.aborted) throw err
})
process.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || !("phase" in value)) return
  if (value.phase === "retire-browser") {
    void browser.dispose().then(
      () => process.send?.({ phase: "browser-retired", pid: process.pid }),
      (err: unknown) => process.send?.({ phase: "browser-retire-failed", pid: process.pid, error: String(err) }),
    )
    return
  }
  if (value.phase === "resume") {
    bridge.resume(cfg.project)
    process.send?.({ phase: "resumed", pid: process.pid })
    return
  }
  if (value.phase === "grant" && "session" in value && typeof value.session === "string") {
    void lease
      .grant({
        sessionID: value.session,
        level: "autonomous",
        duration: "until_stopped",
        applications: "all",
        actions: ["observe", "browser"],
        sensitive: Object.fromEntries(categories.map((name) => [name, "deny"])) as SensitivePolicy,
        cooperativeInput: false,
      })
      .then(() => process.send?.({ phase: "granted", pid: process.pid, session: value.session }))
    return
  }
  if (value.phase !== "stop") return
  void (async () => {
    stopped.abort()
    bridge.dispose()
    await Promise.allSettled([stream, browser.dispose(), disk.writes])
    process.send?.({ phase: "retired", pid: process.pid, actions: stats.actions })
    process.disconnect?.()
  })().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
})
void (async () => {
  await mkdir(join(cfg.root, "artifacts"), { recursive: true })
  await Promise.race([
    connected.promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Host SSE did not connect")), 15_000)),
  ])
  process.send?.({ phase: "ready", pid: process.pid, restored: cfg.phase === 2, journal: restored })
})().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
