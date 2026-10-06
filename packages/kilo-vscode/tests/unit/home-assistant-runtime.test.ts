import { expect, test } from "bun:test"
import { request } from "node:http"
import { createRequire } from "node:module"
import { asSchema, jsonSchema } from "../../../opencode/node_modules/ai"
import { KiloToolSchema } from "../../../opencode/src/kilocode/session/tool-schema"
import { ToolEnvelope } from "../../../opencode/src/kilocode/provider/tool-envelope"
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises"
import { join, resolve, basename, sep } from "node:path"
import { tmpdir } from "node:os"
import { Lights } from "../../src/home-assistant/client"
import { Bridge } from "../../src/home-assistant/bridge"
import { Journal } from "../../src/home-assistant/journal"
import { response } from "../../src/home-assistant/response"
import { selection } from "../../src/home-assistant/policy"
import { Coordinator } from "../../src/home-assistant/coordinator"
import { Settings } from "../../src/home-assistant/settings"
import { Moods, parse as mood, frame } from "../../src/home-assistant/moods"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { Client } from "../../../opencode/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"
import { StreamableHTTPClientTransport } from "../../../opencode/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"

const entity = "light.bedroom_left"
const token = "synthetic-host-only-token"
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(stoppable = true) {
  const root = await mkdtemp(join(tmpdir(), "raya-ha-runtime-"))
  const values = new Map<string, unknown>()
  const state = {
    value: "off",
    brightness: 0 as unknown,
    offset: 0,
    posts: 0,
    fail: false,
    held: false,
    requests: [] as string[],
  }
  const rgb = {
    value: undefined as unknown,
    modes: undefined as unknown,
    mismatch: false,
    missing: false,
    bodies: [] as Record<string, unknown>[],
  }
  const ready = deferred()
  const gate = deferred()
  const storage = {
    get<T>(name: string) {
      return values.get(name) as T | undefined
    },
    async update(name: string, value: unknown) {
      await writeFile(join(root, "journal.json"), JSON.stringify({ [name]: value }))
      if (value === undefined) values.delete(name)
      else values.set(name, value)
    },
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer " + token)
      const path = new URL(request.url).pathname
      state.requests.push(request.method + " " + path)
      if (request.method === "POST") {
        state.posts++
        expect(values.has("raya.homeAssistant.action")).toBe(true)
        const body = (await request.json()) as Record<string, unknown>
        rgb.bodies.push(body)
        if (body.rgb_color !== undefined && !rgb.mismatch) rgb.value = body.rgb_color
        if (body.entity_id === entity) {
          state.value = path.endsWith("turn_on") ? "on" : "off"
          state.brightness = typeof body.brightness === "number" ? body.brightness + state.offset : 255
        }
        if (state.held) {
          ready.resolve()
          await gate.promise
        }
        if (state.fail) return Response.json({ error: "synthetic" }, { status: 503 })
        // HA can return unrelated changed rows. The adapter must read its actual target independently.
        return Response.json([{ entity_id: "light.unrelated", state: "on", attributes: {} }])
      }
      const id = path.slice("/api/states/".length)
      return Response.json({
        entity_id: id,
        state: id.startsWith("scene.") ? "2026-10-03T00:00:00Z" : id.startsWith("script.") ? "off" : state.value,
        attributes: {
          brightness: state.brightness,
          supported_color_modes: rgb.modes,
          rgb_color: rgb.missing ? undefined : rgb.value,
        },
      })
    },
  })
  const config = {
    version: 1,
    origin: `http://127.0.0.1:${server.port}`,
    entities: [entity],
    modes: [
      { name: "sleep_mode", entity: "scene.sleep_mode" },
      ...(stoppable ? [{ name: "wake_mode", entity: "script.wake_mode_sunrise", stop: true }] : []),
    ],
  }
  const journal = new Journal(storage)
  const lights = new Lights(token, config, journal)
  const close = async () => {
    gate.resolve()
    await server.stop()
    const target = resolve(root)
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith("raya-ha-runtime-"))
      throw new Error("Cleanup containment refused")
    await rm(target, { recursive: true, force: true })
  }
  return { root, state, rgb, ready, gate, storage, journal, lights, config, close }
}

test("actual HTTP nullable brightness preserves state and strict goals", async () => {
  const f = await fixture()
  try {
    for (const state of ["off", "on", "unavailable", "unknown"]) {
      f.state.value = state
      for (const brightness of [undefined, null]) {
        f.state.brightness = brightness
        expect(await f.lights.state(entity)).toEqual({
          entity,
          state,
          outcome: "reported",
          uncertain: false,
          color: false,
        })
      }
    }
    f.state.value = "off"
    f.state.brightness = null
    await f.lights.prepare()
    expect(() => f.lights.set(entity, { state: "on", brightness: null })).toThrow()
    expect(() => f.lights.set(entity, { state: "on", brightness: "120" })).toThrow()
    expect(f.state.posts).toBe(0)
    for (const brightness of [0, 255]) {
      f.state.brightness = brightness
      expect((await f.lights.state(entity)).brightness).toBe(brightness)
    }
    await f.lights.dispose()
  } finally {
    await f.close()
  }
})

for (const brightness of ["120", false, {}, [], -1, 256, 1.5]) {
  test(`actual HTTP malformed brightness refuses ${JSON.stringify(brightness)}`, async () => {
    const f = await fixture()
    try {
      f.state.brightness = brightness
      await expect(f.lights.state(entity)).rejects.toThrow("invalid_state")
      expect(f.state.posts).toBe(0)
      await expect(f.lights.dispose()).rejects.toThrow("invalid_state")
    } finally {
      await f.close()
    }
  })
}

test("actual HTTP verifies selected inventory, private token and one target-specific mutation", async () => {
  const f = await fixture()
  try {
    expect(JSON.stringify(f.lights)).not.toContain(token)
    expect(Object.keys(f.lights)).not.toContain("token")
    expect(() => selection({ ...f.config, entities: ["light.unreviewed"] })).toThrow()
    expect(() => selection({ ...f.config, modes: [{ name: "sleep_mode", entity: "script.unreviewed" }] })).toThrow()
    await f.lights.prepare()
    expect(f.state.requests).toContain("GET /api/states/scene.sleep_mode")
    expect(f.state.requests).toContain("GET /api/states/script.wake_mode_sunrise")
    expect(await f.lights.set(entity, { state: "on", brightness: 120 })).toEqual({
      outcome: "reported",
      states: [{ entity, state: "on", brightness: 120, color: false }],
    })
    expect(f.state.posts).toBe(1)
    expect(f.state.requests.filter((row) => row === "GET /api/states/" + entity).length).toBeGreaterThanOrEqual(3)
    expect(f.journal.pending()).toBeUndefined()
    expect(await readFile(join(f.root, "journal.json"), "utf8")).not.toContain(token)
    expect(() => f.lights.set("light.unreviewed", { state: "on" })).toThrow()
    expect(() => f.lights.set(entity, { state: "off", brightness: 1 })).toThrow()
    await f.lights.dispose()
  } finally {
    await f.close()
  }
})

test("one-slot reservation precedes POST, abort retains debt and restart never replays", async () => {
  const f = await fixture()
  f.state.held = true
  const controller = new AbortController()
  try {
    const original = f.lights.set(entity, { state: "on", brightness: 120 }, controller.signal)
    const observed = original.catch((error) => error)
    await f.ready.promise
    expect(() => f.lights.mode("sleep_mode")).toThrow("busy")
    controller.abort()
    f.gate.resolve()
    const failure = await observed
    expect(failure).toBeInstanceOf(Error)
    expect(f.state.posts).toBe(1)
    expect(f.journal.pending()).toBeDefined()
    expect(() => f.lights.set(entity, { state: "off" })).toThrow("prior_action_uncertain")
    await expect(f.lights.dispose()).rejects.toBeInstanceOf(Error)
    const restarted = new Lights(token, f.config, new Journal(f.storage))
    expect(() => restarted.set(entity, { state: "off" })).toThrow("prior_action_uncertain")
    expect(await restarted.reconcile()).toEqual({
      outcome: "reported_reconciled",
      states: [{ entity, state: "on", brightness: 120, color: false }],
    })
    expect(f.state.posts).toBe(1)
    expect(f.journal.pending()).toBeUndefined()
    await restarted.dispose()
  } finally {
    await f.close()
  }
})

test("external fade overrides readback without retry or false completion", async () => {
  const f = await fixture()
  const controller = new AbortController()
  f.state.held = true
  try {
    const job = f.lights.set(entity, { state: "on", brightness: 120 }, controller.signal)
    const failure = job.catch((error: unknown) => error)
    await f.ready.promise
    const count = f.state.requests.filter((row) => row === "GET /api/states/" + entity).length
    f.state.brightness = 64
    f.gate.resolve()
    const deadline = performance.now() + 5000
    while (f.state.requests.filter((row) => row === "GET /api/states/" + entity).length <= count) {
      if (performance.now() >= deadline) throw new Error("Original readback was not observed")
      await Bun.sleep(5)
    }
    controller.abort()
    expect(await failure).toBeInstanceOf(Error)
    expect(f.state.posts).toBe(1)
    expect(f.journal.pending()).toBeDefined()
    expect(() => f.lights.set(entity, { state: "on", brightness: 120 })).toThrow("prior_action_uncertain")
    await expect(f.lights.dispose()).rejects.toBeInstanceOf(Error)
    const restarted = new Lights(token, f.config, new Journal(f.storage))
    await expect(restarted.reconcile()).rejects.toThrow("readback_does_not_match")
    expect(f.state.posts).toBe(1)
    expect(f.journal.pending()).toBeDefined()
    await expect(restarted.dispose()).rejects.toBeInstanceOf(Error)
  } finally {
    controller.abort()
    await f.close()
  }
})

test("named scene accepted and script started are distinct from completed physical change", async () => {
  const f = await fixture()
  try {
    expect((await f.lights.mode("sleep_mode")).outcome).toBe("accepted")
    expect((await f.lights.mode("wake_mode")).outcome).toBe("started")
    expect((await f.lights.mode("wake_mode", "stop")).outcome).toBe("accepted")
    expect(() => f.lights.mode("sleep_mode", "stop")).toThrow()
    expect(f.state.posts).toBe(3)
    await f.lights.dispose()
  } finally {
    await f.close()
  }
})

test("HTTP failure never retries and durable uncertainty survives original local joins", async () => {
  const f = await fixture()
  f.state.fail = true
  try {
    await expect(f.lights.set(entity, { state: "on" })).rejects.toThrow("http_503")
    expect(f.state.posts).toBe(1)
    expect(f.journal.pending()).toBeDefined()
    expect(() => f.lights.set(entity, { state: "off" })).toThrow("prior_action_uncertain")
    await expect(f.lights.dispose()).rejects.toBeInstanceOf(Error)
  } finally {
    await f.close()
  }
})

test("abort during original reader cleanup blocks delivery and distinct cleanup errors survive", async () => {
  const gate = deferred()
  const ready = deferred()
  const controller = new AbortController()
  const state = { reads: 0 }
  const reader = {
    read: async () =>
      state.reads++ === 0 ? { done: false, value: new TextEncoder().encode("{}") } : { done: true, value: undefined },
    cancel: async () => {
      ready.resolve()
      await gate.promise
    },
    releaseLock: () => undefined,
  }
  const raw = {
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    body: { getReader: () => reader },
  } as unknown as Response
  // A genuine response implementation is invoked; only the native reader boundary is controlled.
  const job = response(raw, controller.signal, false).catch((error) => error)
  await ready.promise
  controller.abort()
  gate.resolve()
  expect((await job).message).toContain("aborted_or_expired")
  const failure = new Error("Synthetic read failure")
  const cleanup = new Error("Synthetic original cleanup failure")
  const broken = {
    ok: true,
    headers: raw.headers,
    body: {
      getReader: () => ({
        read: async () => {
          throw failure
        },
        cancel: async () => {
          throw cleanup
        },
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Response
  const error = await response(broken, new AbortController().signal, true).catch((error) => error)
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors).toHaveLength(2)
})

test("actual MCP SDK negotiates, lists and calls the bounded authenticated bridge", async () => {
  const f = await fixture()
  const bridge = new Bridge(f.lights)
  const client = new Client({ name: "synthetic-fixture", version: "1" })
  try {
    await f.lights.prepare()
    const endpoint = await bridge.open()
    expect(endpoint.url).not.toContain(token)
    expect(JSON.stringify(endpoint)).not.toContain(token)
    const unauthorized = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(unauthorized.status).toBe(403)
    const origin = await fetch(endpoint.url, {
      method: "POST",
      headers: { ...endpoint.headers, Origin: "https://untrusted.example", "content-type": "application/json" },
      body: "{}",
    })
    expect(origin.status).toBe(403)
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: endpoint.headers },
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1,
        initialReconnectionDelay: 1,
        reconnectionDelayGrowFactor: 1,
      },
    })
    await client.connect(transport)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "lights_read",
      "lights_set",
      "lights_mode",
    ])
    const result = await client.callTool({ name: "lights_set", arguments: { entity, state: "on", brightness: 120 } })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result)).not.toContain(token)
    const denied = await client.callTool({ name: "lights_set", arguments: { entity: "light.unreviewed", state: "on" } })
    expect(denied.isError).toBe(true)
    expect(f.state.posts).toBe(1)
    await transport.terminateSession()
    await client.close()
    await bridge.dispose()
  } finally {
    await client.close()
    await f.close()
  }
}, 15000)

test("actual CLI SDK registration is directory scoped and stale completion cannot own new backend", async () => {
  const f = await fixture()
  const held = deferred()
  const ready = deferred()
  const added = deferred()
  async function backend(slow: boolean) {
    const rows = new Map<string, { client: Client; transport: StreamableHTTPClientTransport }>()
    const state = { adds: 0, disconnects: 0, urls: new Set<string>() }
    const closed = deferred()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const dir = url.searchParams.get("directory") ?? ""
        if (url.pathname === "/mcp" && request.method === "POST") {
          state.adds++
          const body = (await request.json()) as {
            name: string
            config: { url: string; headers: Record<string, string>; oauth: boolean }
          }
          expect(body.name).toBe("raya_home_assistant")
          state.urls.add(body.config.url)
          expect(body.config.oauth).toBe(false)
          expect(JSON.stringify(body)).not.toContain(token)
          const transport = new StreamableHTTPClientTransport(new URL(body.config.url), {
            requestInit: { headers: body.config.headers },
            reconnectionOptions: {
              maxRetries: 0,
              maxReconnectionDelay: 1,
              initialReconnectionDelay: 1,
              reconnectionDelayGrowFactor: 1,
            },
          })
          const client = new Client({ name: "synthetic-backend", version: "1" })
          await client.connect(transport)
          rows.set(dir, { client, transport })
          if (slow) {
            if (rows.size === 2) ready.resolve()
            await held.promise
          } else if (rows.size === 2) added.resolve()
          // Exact current Core handler shape: StatusMap directly, not {status: StatusMap}.
          return Response.json({ raya_home_assistant: { status: "connected" } })
        }
        if (url.pathname === "/mcp/raya_home_assistant/disconnect") {
          state.disconnects++
          const row = rows.get(dir)
          if (row) {
            await row.client.close()
            rows.delete(dir)
          }
          if (state.disconnects === 2) closed.resolve()
          return Response.json(true)
        }
        return Response.json({ error: "synthetic route refused" }, { status: 404 })
      },
    })
    const client = createKiloClient({ baseUrl: `http://127.0.0.1:${server.port}` })
    const close = async () => {
      held.resolve()
      for (const row of rows.values()) await row.client.close()
      await server.stop()
    }
    return { rows, state, client, close, closed }
  }
  const first = await backend(true)
  const second = await backend(false)
  type Connection = ConstructorParameters<typeof Coordinator>[0]
  const listeners = new Set<Parameters<Connection["onStateChange"]>[0]>()
  const events = new Set<Parameters<Connection["onEvent"]>[0]>()
  const state = { client: first.client }
  const connection: Connection = {
    getClient: () => state.client,
    getKnownDirectories: () => ["C:/Synthetic/Chat", "C:/Synthetic/Worktree"],
    getConnectionState: () => "connected",
    isClientCurrent: (client) => client === state.client,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onEvent: (listener) => {
      events.add(listener)
      return () => {
        events.delete(listener)
      }
    },
  }
  const secrets = new Map<string, string>()
  const settings = new Settings(f.storage, {
    get: async (name) => secrets.get(name),
    store: async (name, value) => {
      secrets.set(name, value)
    },
    delete: async (name) => {
      secrets.delete(name)
    },
  })
  await settings.save(f.config, token)
  const owner = new Coordinator(connection, settings, f.journal)
  try {
    const original = owner.initialize()
    await ready.promise
    state.client = second.client
    const stale = first.rows.get("C:/Synthetic/Chat")!
    await expect(stale.client.callTool({ name: "lights_set", arguments: { entity, state: "on" } })).rejects.toThrow()
    expect(f.state.posts).toBe(0)
    for (const listener of listeners) listener("connected")
    await added.promise
    held.resolve()
    await original
    await first.closed.promise
    expect(first.state.disconnects).toBe(2)
    expect(second.state.adds).toBe(2)
    expect(second.state.urls.size).toBe(2)
    expect(second.rows.has("C:/Synthetic/Worktree")).toBe(true)
    expect(second.rows.has("C:/Synthetic/Chat")).toBe(true)
    const row = second.rows.get("C:/Synthetic/Chat")!
    expect((await row.client.listTools()).tools.map((tool) => tool.name)).toContain("lights_set")
    expect((await row.client.callTool({ name: "lights_set", arguments: { entity, state: "on" } })).isError).not.toBe(
      true,
    )
    await owner.dispose()
    expect(second.state.disconnects).toBe(2)
    expect(listeners.size).toBe(0)
    expect(events.size).toBe(0)
    await expect(owner.configure(f.config, token)).rejects.toThrow("closed_or_busy")
  } finally {
    held.resolve()
    const settled = await Promise.allSettled([owner.dispose(), first.close(), second.close()])
    await f.close()
    const errors = settled.flatMap((item) => (item.status === "rejected" ? [item.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Synthetic runtime cleanup failed")
  }
}, 15000)

test("shutdown joins the original held journal write and never sends cancelled reserved action", async () => {
  const f = await fixture()
  const ready = deferred()
  const gate = deferred()
  const journal = new Journal({
    get: f.storage.get,
    async update(name, value) {
      if (value !== undefined) {
        ready.resolve()
        await gate.promise
      }
      await f.storage.update(name, value)
    },
  })
  const owner = new Lights(token, f.config, journal)
  try {
    const original = owner.set(entity, { state: "on" }).catch((error: unknown) => error)
    await ready.promise
    const state = { closed: false }
    const closing = owner
      .dispose()
      .catch((error: unknown) => error)
      .finally(() => {
        state.closed = true
      })
    await Promise.resolve()
    expect(state.closed).toBe(false)
    expect(f.state.posts).toBe(0)
    expect(() => owner.set(entity, { state: "off" })).toThrow("closed")
    gate.resolve()
    expect(await original).toBeInstanceOf(Error)
    expect(await closing).toBeInstanceOf(Error)
    expect(f.state.posts).toBe(0)
    expect(journal.pending()).toBeDefined()
    expect(await readFile(join(f.root, "journal.json"), "utf8")).not.toContain(token)
  } finally {
    gate.resolve()
    await f.close()
  }
})

test("failed debt clearance restores the exact original record before refusing later mutation", async () => {
  const f = await fixture()
  const fault = new Error("Synthetic clearance failed")
  const journal = new Journal({
    get: f.storage.get,
    async update(name, value) {
      await f.storage.update(name, value)
      if (value === undefined) throw fault
    },
  })
  const owner = new Lights(token, f.config, journal)
  try {
    await expect(owner.set(entity, { state: "on" })).rejects.toThrow()
    expect(f.state.posts).toBe(1)
    const debt = journal.pending()!
    expect(debt.action).toEqual({ entity, goal: { state: "on" } })
    const persisted = JSON.parse(await readFile(join(f.root, "journal.json"), "utf8")) as Record<string, unknown>
    expect(persisted["raya.homeAssistant.action"]).toEqual(debt)
    expect(() => owner.set(entity, { state: "off" })).toThrow("prior_action_uncertain")
    await expect(owner.dispose()).rejects.toThrow()
    expect(f.state.posts).toBe(1)
  } finally {
    await f.close()
  }
})

test("failed authenticated inventory never publishes an MCP capability", async () => {
  const f = await fixture()
  f.state.value = "unavailable"
  const secrets = new Map<string, string>()
  const settings = new Settings(f.storage, {
    get: async (name) => secrets.get(name),
    store: async (name, value) => {
      secrets.set(name, value)
    },
    delete: async (name) => {
      secrets.delete(name)
    },
  })
  await settings.save(f.config, token)
  const client = createKiloClient({ baseUrl: f.config.origin })
  const owner = new Coordinator(
    {
      getClient: () => client,
      getKnownDirectories: () => ["C:/Synthetic/Chat"],
      getConnectionState: () => "connected",
      isClientCurrent: (value) => value === client,
      onStateChange: () => () => undefined,
      onEvent: () => () => undefined,
    },
    settings,
    f.journal,
  )
  try {
    await expect(owner.initialize()).rejects.toThrow("unavailable")
    expect(f.state.posts).toBe(0)
    expect(f.state.requests.some((value) => value.includes("/mcp"))).toBe(false)
    await expect(owner.dispose()).rejects.toThrow()
    expect(f.state.posts).toBe(0)
  } finally {
    await f.close()
  }
})

test("duplicate original MCP request joins one mutation and conflicting reuse refuses", async () => {
  const f = await fixture()
  f.state.held = true
  const bridge = new Bridge(f.lights)
  const client = new Client({ name: "synthetic-duplicate", version: "1" })
  try {
    await f.lights.prepare()
    const endpoint = await bridge.open()
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: endpoint.headers },
    })
    await client.connect(transport)
    const headers = { ...endpoint.headers, "Content-Type": "application/json", "Mcp-Session-Id": transport.sessionId! }
    const body = {
      jsonrpc: "2.0",
      id: "held-original",
      method: "tools/call",
      params: { name: "lights_set", arguments: { entity, state: "on" } },
    }
    const first = fetch(endpoint.url, { method: "POST", headers, body: JSON.stringify(body) })
    await f.ready.promise
    const second = fetch(endpoint.url, { method: "POST", headers, body: JSON.stringify(body) })
    f.gate.resolve()
    const results = await Promise.all([first, second])
    expect(results.map((value) => value.status)).toEqual([200, 200])
    expect(await results[0].json()).toEqual(await results[1].json())
    expect(f.state.posts).toBe(1)
    const conflict = await fetch(endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, params: { name: "lights_set", arguments: { entity, state: "off" } } }),
    })
    expect(conflict.status).toBe(409)
    await conflict.arrayBuffer()
    expect(f.state.posts).toBe(1)
    await client.close()
    await bridge.dispose()
  } finally {
    f.gate.resolve()
    const results = await Promise.allSettled([client.close(), bridge.dispose()])
    await f.close()
    const errors = results.flatMap((value) => (value.status === "rejected" ? [value.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Synthetic duplicate cleanup failed")
  }
})

test("revoked capability cannot admit an original held HTTP body after disposal", async () => {
  const f = await fixture()
  const ready = deferred()
  const state = { current: true, body: false }
  const bridge = new Bridge(
    f.lights,
    () => {
      if (state.body) ready.resolve()
      return state.current
    },
    false,
  )
  try {
    await f.lights.prepare()
    const endpoint = await bridge.open()
    const initialized = await fetch(endpoint.url, {
      method: "POST",
      headers: { ...endpoint.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      }),
    })
    const session = initialized.headers.get("mcp-session-id")!
    await initialized.arrayBuffer()
    state.body = true
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "original-body",
      method: "tools/call",
      params: { name: "lights_set", arguments: { entity, state: "on" } },
    })
    const received = deferred()
    const codes: number[] = []
    const original = request(
      endpoint.url,
      {
        method: "POST",
        headers: {
          ...endpoint.headers,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Mcp-Session-Id": session,
        },
      },
      (response) => {
        codes.push(response.statusCode!)
        response.resume()
        response.once("end", received.resolve)
      },
    )
    const failed = new Promise<never>((_, reject) => original.once("error", reject))
    original.write(body.slice(0, -1))
    await ready.promise
    state.current = false
    const closing = bridge.dispose()
    original.end(body.slice(-1))
    await Promise.race([received.promise, failed])
    await closing
    expect(f.state.posts).toBe(0)
    expect(codes).toEqual([403])
    expect(f.journal.pending()).toBeUndefined()
    await f.lights.dispose()
  } finally {
    const results = await Promise.allSettled([bridge.dispose(), f.lights.dispose()])
    await f.close()
    const errors = results.flatMap((value) => (value.status === "rejected" ? [value.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Synthetic held body cleanup failed")
  }
})

test("configuration close joins held credential load without creating a late HTTP owner", async () => {
  const f = await fixture()
  const ready = deferred()
  const gate = deferred()
  const secrets = new Map<string, string>()
  const settings = new Settings(f.storage, {
    get: async (name) => {
      ready.resolve()
      await gate.promise
      return secrets.get(name)
    },
    store: async (name, value) => {
      secrets.set(name, value)
    },
    delete: async (name) => {
      secrets.delete(name)
    },
  })
  const client = createKiloClient({ baseUrl: f.config.origin })
  const owner = new Coordinator(
    {
      getClient: () => client,
      getKnownDirectories: () => ["C:/Synthetic/Chat"],
      getConnectionState: () => "connected",
      isClientCurrent: (value) => value === client,
      onStateChange: () => () => undefined,
      onEvent: () => () => undefined,
    },
    settings,
    f.journal,
  )
  try {
    const original = owner.configure(f.config, token)
    await ready.promise
    const state = { closed: false }
    const closing = owner.dispose().finally(() => {
      state.closed = true
    })
    await Promise.resolve()
    expect(state.closed).toBe(false)
    gate.resolve()
    await original
    await closing
    expect(f.state.requests).toEqual([])
    await expect(owner.configure(f.config, token)).rejects.toThrow("closed_or_busy")
  } finally {
    gate.resolve()
    await owner.dispose()
    await f.close()
  }
})

test("actual HTTP sends and verifies RGB only for capable requested targets", async () => {
  const f = await fixture()
  try {
    const tuple = [255, 0, 0]
    for (const value of [
      new Array(3),
      [Infinity, 0, 0],
      [255, 0],
      [255, 0, 0, 0],
      [256, 0, 0],
      [-1, 0, 0],
      [0.5, 0, 0],
      [NaN, 0, 0],
      ["255", 0, 0],
      null,
    ])
      expect(() => f.lights.set(entity, { state: "on", rgb_color: value })).toThrow()
    expect(() => f.lights.set(entity, { state: "off", rgb_color: tuple })).toThrow()
    await expect(f.lights.set(entity, { state: "on", rgb_color: tuple })).rejects.toThrow("color_not_supported")
    expect(f.state.posts).toBe(0)
    expect(f.journal.pending()).toBeUndefined()
    f.rgb.modes = ["rgb"]
    const result = await f.lights.set(entity, { state: "on", rgb_color: tuple })
    expect(result.states[0].rgb_color).toEqual(tuple)
    expect(result.states[0].color).toBe(true)
    expect(f.rgb.bodies).toEqual([{ entity_id: entity, rgb_color: tuple }])
    expect(f.state.posts).toBe(1)
    expect(f.journal.pending()).toBeUndefined()
  } finally {
    await f.close()
  }
})

test.each([false, true])("actual missing or mismatched RGB retains debt after one dispatch %s", async (missing) => {
  const f = await fixture()
  try {
    f.rgb.modes = ["rgb"]
    f.rgb.value = [0, 0, 255]
    f.rgb.mismatch = true
    f.rgb.missing = missing
    const abort = new AbortController()
    const job = f.lights.set(entity, { state: "on", rgb_color: [255, 0, 0] }, abort.signal)
    while (f.state.requests.filter((row) => row === "GET /api/states/" + entity).length < 2) await Bun.sleep(5)
    abort.abort()
    await expect(job).rejects.toThrow()
    expect(f.state.posts).toBe(1)
    expect(f.journal.pending()?.action).toEqual({ entity, goal: { state: "on", rgb_color: [255, 0, 0] } })
    expect(() => f.lights.set(entity, { state: "on", rgb_color: [255, 0, 0] })).toThrow("prior_action_uncertain")
    expect(f.state.posts).toBe(1)
  } finally {
    await f.close()
  }
})

test.each([false, true])(
  "actual MCP schemas preserve RGB and stoppable-script capabilities through tool sanitization/envelope %s",
  async (stoppable) => {
    const f = await fixture(stoppable)
    const bridge = new Bridge(f.lights)
    const client = new Client({ name: "synthetic-schema", version: "1" })
    const require = createRequire(import.meta.url)
    const Ajv = createRequire(require.resolve("eslint/package.json"))("ajv")
    const validator = new Ajv({ strict: false })
    try {
      f.rgb.modes = ["rgb"]
      await f.lights.prepare()
      const endpoint = await bridge.open()
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }),
      )
      const definitions = (await client.listTools()).tools
      const sanitized = await KiloToolSchema.sanitize(
        Object.fromEntries(definitions.map((tool) => [tool.name, { inputSchema: jsonSchema(tool.inputSchema) }])),
      )
      const tools = Object.entries(sanitized).map(([name, tool]) => ({
        function: { name, parameters: asSchema(tool.inputSchema).jsonSchema },
      }))
      const envelope = validator.compile(ToolEnvelope.schema(tools, "required"))
      expect(envelope({ kind: "tool", name: "lights_mode", arguments: { mode: "sleep_mode", action: "stop" } })).toBe(
        false,
      )
      expect(envelope({ kind: "tool", name: "lights_mode", arguments: { mode: "wake_mode", action: "stop" } })).toBe(
        stoppable,
      )
      expect(envelope({ kind: "tool", name: "lights_mode", arguments: { mode: "sleep_mode" } })).toBe(true)
      expect(
        envelope({ kind: "tool", name: "lights_set", arguments: { entity, state: "off", rgb_color: [255, 0, 0] } }),
      ).toBe(false)
      expect(
        envelope({ kind: "tool", name: "lights_set", arguments: { entity, state: "on", rgb_color: [255, 0, 0] } }),
      ).toBe(true)
      expect(
        envelope({ kind: "tool", name: "lights_set", arguments: { entity, state: "on", rgb_color: [255.5, 0, 0] } }),
      ).toBe(false)
      const result = await client.callTool({
        name: "lights_set",
        arguments: { entity, state: "on", rgb_color: [255, 0, 0] },
      })
      expect(result.isError).not.toBe(true)
      expect(f.rgb.bodies).toEqual([{ entity_id: entity, rgb_color: [255, 0, 0] }])
    } finally {
      await client.close()
      await bridge.dispose()
      await f.close()
    }
  },
  15000,
)

const palette = {
  name: "cinema",
  theme: "Amber and forest green inspired by the requested show",
  sources: ["https://www.netflix.com/title/81437051"],
  palette: [
    [255, 120, 0],
    [0, 80, 20],
  ],
  seconds: 60,
  duration: 60,
  lights: [{ entity, brightness: 64, phase: 0 }],
}

test("dynamic mood validates bounds, source metadata and staggered interpolation", () => {
  const value = mood(palette, [entity])
  expect(frame(value, 0)[0].rgb_color).toEqual([255, 120, 0])
  expect(frame(value, 15)[0].rgb_color).toEqual([128, 100, 10])
  expect(frame(value, 60)[0].rgb_color).toEqual([255, 120, 0])
  for (const input of [
    { ...palette, duration: 10801 },
    { ...palette, seconds: 1 },
    { ...palette, sources: ["file:///private"] },
    { ...palette, lights: [{ entity: "light.unrelated", brightness: 64, phase: 0 }] },
    { ...palette, lights: [palette.lights[0], palette.lights[0]] },
    {
      ...palette,
      palette: [
        [256, 0, 0],
        [0, 0, 0],
      ],
    },
  ])
    expect(() => mood(input, [entity])).toThrow()
})

test("saved moods read back metadata and remain idle after reopening; overwrite is explicit", async () => {
  const f = await fixture()
  const owner = new Moods(f.lights, f.storage)
  try {
    const result = await owner.save(palette)
    expect(result.outcome).toBe("saved")
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(f.state.posts).toBe(0)
    await expect(owner.save(palette)).rejects.toThrow("mood_exists")
    await owner.save({ ...palette, theme: "Revised inspiration" }, true)
    const reopened = new Moods(f.lights, f.storage)
    expect(reopened.list().activity.state).toBe("idle")
    expect(reopened.list().moods[0].theme).toBe("Revised inspiration")
    await reopened.dispose()
  } finally {
    await owner.dispose()
    await f.lights.dispose()
    await f.close()
  }
})

test("dynamic mood confirms the first real HTTP frame and joins cancellation without subsequent writes", async () => {
  const f = await fixture()
  const owner = new Moods(f.lights, f.storage)
  try {
    f.rgb.modes = ["rgb"]
    await owner.save(palette)
    expect((await owner.start("cinema", new AbortController().signal)).outcome).toBe("started")
    expect(f.rgb.value).toEqual([255, 120, 0])
    expect(f.state.brightness).toBe(64)
    expect(owner.list().activity.state).toBe("running")
    await owner.stop()
    const posts = f.state.posts
    await Bun.sleep(30)
    expect(f.state.posts).toBe(posts)
    expect(owner.list().activity.state).toBe("stopped")
    expect(f.journal.pending()).toBeUndefined()
  } finally {
    await owner.dispose()
    await f.lights.dispose()
    await f.close()
  }
})

test("an external colour override retires the mood instead of overwriting the new colour", async () => {
  const f = await fixture()
  const owner = new Moods(f.lights, f.storage)
  try {
    f.rgb.modes = ["rgb"]
    await owner.save(palette)
    await owner.start("cinema", new AbortController().signal)
    f.rgb.value = [255, 0, 0]
    const posts = f.state.posts
    await Bun.sleep(2200)
    expect(owner.list().activity).toEqual({ name: "cinema", state: "failed", code: "mood_external_change" })
    expect(f.state.posts).toBe(posts)
    expect(f.rgb.value).toEqual([255, 0, 0])
  } finally {
    await owner.dispose()
    await f.lights.dispose()
    await f.close()
  }
}, 10000)

test("a one-step external dim retires the mood without undoing a gradual sleep fade", async () => {
  const f = await fixture()
  const owner = new Moods(f.lights, f.storage)
  try {
    f.rgb.modes = ["rgb"]
    await owner.save(palette)
    await owner.start("cinema", new AbortController().signal)
    f.state.brightness = 63
    const posts = f.state.posts
    await Bun.sleep(2200)
    expect(owner.list().activity).toEqual({ name: "cinema", state: "failed", code: "mood_external_change" })
    expect(f.state.posts).toBe(posts)
    expect(f.state.brightness).toBe(63)
  } finally {
    await owner.dispose()
    await f.lights.dispose()
    await f.close()
  }
}, 10000)

test("mood ownership compares settled readback so device brightness rounding does not interrupt it", async () => {
  const f = await fixture()
  const owner = new Moods(f.lights, f.storage)
  try {
    f.rgb.modes = ["rgb"]
    f.state.offset = -1
    await owner.save(palette)
    await owner.start("cinema", new AbortController().signal)
    expect(f.state.brightness).toBe(63)
    const posts = f.state.posts
    await Bun.sleep(2200)
    expect(owner.list().activity.state).toBe("running")
    expect(f.state.posts).toBeGreaterThan(posts)
    expect(f.state.brightness).toBe(63)
    await owner.stop()
  } finally {
    await owner.dispose()
    await f.lights.dispose()
    await f.close()
  }
}, 10000)

test("a real timed mood expires without another write and preserves the last reported colour", async () => {
  const f = await fixture()
  const owner = new Moods(f.lights, f.storage)
  try {
    f.rgb.modes = ["rgb"]
    await owner.save(palette)
    await owner.start("cinema", new AbortController().signal)
    const deadline = performance.now() + 65000
    while (owner.list().activity.state === "running" && performance.now() < deadline) await Bun.sleep(1000)
    expect(owner.list().activity).toEqual({ name: "cinema", state: "completed" })
    expect(f.state.posts).toBeGreaterThan(1)
    expect(f.journal.pending()).toBeUndefined()
    const posts = f.state.posts
    const colour = f.rgb.value
    await Bun.sleep(2200)
    expect(f.state.posts).toBe(posts)
    expect(f.rgb.value).toEqual(colour)
    const reopened = new Moods(f.lights, f.storage)
    expect(reopened.list().activity.state).toBe("idle")
    expect(reopened.list().moods[0].name).toBe("cinema")
    await reopened.dispose()
  } finally {
    await owner.dispose()
    await f.lights.dispose()
    await f.close()
  }
}, 75000)

test("mood MCP save/start/stop uses the real adapter and a manual command retires its cycle", async () => {
  const f = await fixture()
  const owner = new Moods(f.lights, f.storage)
  const bridge = new Bridge(f.lights, () => true, false, owner)
  const client = new Client({ name: "synthetic-mood-client", version: "1" })
  try {
    f.rgb.modes = ["rgb"]
    const endpoint = await bridge.open()
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }),
    )
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("moods_start")
    expect((await client.callTool({ name: "moods_save", arguments: { mood: palette } })).isError).not.toBe(true)
    expect(f.state.posts).toBe(0)
    expect((await client.callTool({ name: "moods_start", arguments: { name: "cinema" } })).isError).not.toBe(true)
    expect((await client.callTool({ name: "lights_set", arguments: { entity, state: "off" } })).isError).not.toBe(true)
    expect(owner.list().activity.state).toBe("stopped")
    expect(f.state.value).toBe("off")
  } finally {
    await client.close()
    await bridge.dispose()
    await owner.dispose()
    await f.lights.dispose()
    await f.close()
  }
}, 15000)

test("stop during the first held HTTP action joins startup and preserves uncertainty without replay", async () => {
  const f = await fixture()
  const owner = new Moods(f.lights, f.storage)
  try {
    f.rgb.modes = ["rgb"]
    f.state.held = true
    await owner.save(palette)
    const starting = owner.start("cinema", new AbortController().signal)
    const failed = starting.then(
      () => undefined,
      (error: unknown) => error,
    )
    await f.ready.promise
    const stopping = owner.stop()
    f.gate.resolve()
    expect(await failed).toBeInstanceOf(Error)
    await stopping
    expect(f.state.posts).toBe(1)
    expect(f.journal.pending()).toBeDefined()
    expect(owner.list().activity.state).toBe("failed")
    await expect(owner.start("cinema", new AbortController().signal)).rejects.toThrow("prior_action_uncertain")
    expect(f.state.posts).toBe(1)
  } finally {
    await owner.dispose()
    await Promise.allSettled([f.lights.dispose()])
    await f.close()
  }
}, 15000)
