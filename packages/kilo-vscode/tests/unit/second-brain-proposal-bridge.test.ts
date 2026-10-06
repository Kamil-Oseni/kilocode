import { afterEach, expect, test } from "bun:test"
import { createKiloClient, type SecondBrainRequest } from "@kilocode/sdk/v2/client"
import { BrainBridge } from "../../src/second-brain/bridge"
import type { CanvasConnection } from "../../src/services/canvas/canvas-bridge"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
})

/** Real SDK HTTP; controlled host metadata only, never native trust/confirmation credit. */
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "raya-proposal-bridge-"))
  const replies: unknown[] = []
  const rejects: unknown[] = []
  const queued: SecondBrainRequest[] = []
  const reads: string[] = []
  const state = { failed: false }
  const gates = new Map<
    string,
    { entered: ReturnType<typeof Promise.withResolvers<void>>; held: ReturnType<typeof Promise.withResolvers<void>> }
  >()
  const wait = async (action: string) => {
    const gate = gates.get(action)
    if (!gate) return
    gate.entered.resolve()
    await gate.held.promise
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET") {
        reads.push(url.toString())
        await wait("list")
        return Response.json(queued)
      }
      const body: unknown = await request.json()
      if (url.pathname.endsWith("/reply")) replies.push(body)
      if (url.pathname.endsWith("/reject")) {
        rejects.push(body)
        await wait("reject")
      }
      return Response.json(state.failed ? { error: { code: "unconfirmed" } } : { ok: true }, {
        status: state.failed ? 503 : 200,
      })
    },
  })
  cleanup.push(async () => {
    for (const gate of gates.values()) gate.held.resolve()
    await server.stop()
    if (
      path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith("raya-proposal-bridge-")
    )
      throw new Error("Private fixture cleanup escaped its selected root")
    await rm(root, { recursive: true })
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  let selected = client
  let online = true
  const events = new Set<(event: SSEPayload, directory?: string) => void>()
  const states = new Set<Parameters<CanvasConnection["onStateChange"]>[0]>()
  const connection: CanvasConnection = {
    getClient: () => {
      if (!online) throw new Error("Controlled connection disconnected")
      return selected
    },
    getKnownDirectories: () => [root],
    onEvent: (listener) => {
      events.add(listener)
      return () => {
        events.delete(listener)
      }
    },
    onStateChange: (listener) => {
      states.add(listener)
      return () => {
        states.delete(listener)
      }
    },
  }
  return {
    root,
    replies,
    rejects,
    queued,
    reads,
    connection,
    hold(action: "list" | "reject") {
      const gate = { entered: Promise.withResolvers<void>(), held: Promise.withResolvers<void>() }
      gates.set(action, gate)
      return gate
    },
    replace(value: typeof client) {
      selected = value
    },
    disconnect() {
      online = false
      for (const listener of states) listener("disconnected")
    },
    fail() {
      state.failed = true
    },
    event(value: unknown) {
      for (const listener of events) listener(value as SSEPayload, root)
    },
    connected() {
      online = true
      for (const listener of states) listener("connected")
    },
  }
}

async function until(check: () => boolean) {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() >= end) throw new Error("Original bridge response did not settle")
    await Bun.sleep(1)
  }
}

test("proposal bridge uses real SDK reply once and refuses foreign project before host entry", async () => {
  const cfg = await fixture()
  const marker = path.join(cfg.root, "host-entry.txt")
  const bridge = new BrainBridge(cfg.connection, {
    model: async (request) => {
      await writeFile(marker, "entered", { flag: "wx" })
      return { action: "list", project: request.project, proposals: [] }
    },
  })
  const request: SecondBrainRequest = {
    id: "req-list",
    sessionID: "ses-fixture",
    project: cfg.root,
    command: { action: "list" },
  }
  cfg.event({ type: "kilocode.second_brain.requested", properties: request })
  await until(() => cfg.replies.length === 1)
  cfg.event({ type: "kilocode.second_brain.requested", properties: request })
  cfg.event({
    type: "kilocode.second_brain.requested",
    properties: { ...request, id: "req-foreign", project: path.join(cfg.root, "foreign") },
  })
  await until(() => cfg.rejects.length === 1)
  await bridge.close()
  expect(cfg.replies).toEqual([{ result: { action: "list", project: cfg.root, proposals: [] } }])
  expect(await readFile(marker, "utf8")).toBe("entered")
  expect(cfg.rejects[0]).toMatchObject({ error: { code: "conflict" } })
})

test("recovered proposal creation is refused without replay", async () => {
  const cfg = await fixture()
  const source = path.join(cfg.root, "source.txt")
  await writeFile(source, "private evidence")
  cfg.queued.push({
    id: "req-unknown",
    sessionID: "ses-fixture",
    project: cfg.root,
    command: {
      action: "propose",
      id: crypto.randomUUID(),
      request: {
        changes: [{ path: "Areas/review.md", expected: "a".repeat(64), content: "Reviewed evidence" }],
        sources: [
          {
            path: source,
            sha256: new Bun.CryptoHasher("sha256").update(await readFile(source)).digest("hex"),
            kind: "document",
            event_time: "2026-10-05",
          },
        ],
      },
    },
  })
  const bridge = new BrainBridge(cfg.connection, {
    model: async () => {
      throw new Error("Recovered write must not enter")
    },
  })
  cfg.connected()
  await until(() => cfg.rejects.length === 1)
  await bridge.close()
  expect(cfg.replies).toEqual([])
  expect(cfg.rejects[0]).toMatchObject({ error: { code: "conflict" } })
})

test("only original session cancellation aborts; close joins held original host work", async () => {
  const cfg = await fixture()
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<AbortSignal>()
  const bridge = new BrainBridge(cfg.connection, {
    model: async (request, _directory, signal) => {
      entered.resolve(signal)
      await held.promise
      signal.throwIfAborted()
      return { action: "list", project: request.project, proposals: [] }
    },
  })
  cfg.event({
    type: "kilocode.second_brain.requested",
    properties: { id: "req-held", sessionID: "ses-original", project: cfg.root, command: { action: "list" } },
  })
  const signal = await entered.promise
  cfg.event({
    type: "kilocode.second_brain.cancelled",
    properties: { requestID: "req-held", sessionID: "ses-foreign", reason: "cancelled" },
  })
  expect(signal.aborted).toBe(false)
  cfg.event({
    type: "kilocode.second_brain.cancelled",
    properties: { requestID: "req-held", sessionID: "ses-original", reason: "cancelled" },
  })
  expect(signal.aborted).toBe(true)
  const closed = bridge.close()
  const observed = await Promise.race([closed.then(() => "closed"), Bun.sleep(10).then(() => "held")])
  expect(observed).toBe("held")
  held.resolve()
  await closed
  expect(cfg.replies).toEqual([])
  expect(cfg.rejects).toEqual([])
})

test("original reply and rejection failures remain retained after active work ends", async () => {
  const cfg = await fixture()
  cfg.fail()
  const bridge = new BrainBridge(cfg.connection, {
    model: async (request) => ({ action: "list", project: request.project, proposals: [] }),
  })
  cfg.event({
    type: "kilocode.second_brain.requested",
    properties: { id: "req-failed", sessionID: "ses-original", project: cfg.root, command: { action: "list" } },
  })
  await until(() => cfg.rejects.length === 1)
  await Bun.sleep(10)
  await expect(bridge.close()).rejects.toBeInstanceOf(AggregateError)
  expect(cfg.replies).toHaveLength(1)
  expect(cfg.rejects).toHaveLength(1)
})

test("retained host work cannot reply or reject after SDK client replacement", async () => {
  const cfg = await fixture()
  const next = await fixture()
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const bridge = new BrainBridge(cfg.connection, {
    model: async (request) => {
      entered.resolve()
      await held.promise
      return { action: "list", project: request.project, proposals: [] }
    },
  })
  try {
    cfg.event({
      type: "kilocode.second_brain.requested",
      properties: { id: "req-replaced", sessionID: "ses-original", project: cfg.root, command: { action: "list" } },
    })
    await entered.promise
    cfg.replace(next.connection.getClient())
    held.resolve()
    await until(() => Reflect.get(bridge, "jobs").size === 0)
    await bridge.close()
    expect(cfg.replies).toEqual([])
    expect(cfg.rejects).toEqual([])
    expect(next.replies).toEqual([])
    expect(next.rejects).toEqual([])
  } finally {
    held.resolve()
    await bridge.close()
  }
})

test("a delayed recovery list cannot enter the host after SDK client replacement", async () => {
  const cfg = await fixture()
  const next = await fixture()
  const gate = cfg.hold("list")
  const entries: string[] = []
  cfg.queued.push({ id: "req-stale", sessionID: "ses-original", project: cfg.root, command: { action: "list" } })
  const bridge = new BrainBridge(cfg.connection, {
    model: async (request) => {
      entries.push(request.id)
      return { action: "list", project: request.project, proposals: [] }
    },
  })
  try {
    cfg.connected()
    await gate.entered.promise
    cfg.replace(next.connection.getClient())
    gate.held.resolve()
    // Let the actual original SDK list settle before closing; disposal must not mask stale recovery.
    await until(() => Reflect.get(bridge, "recovery") === undefined)
    expect(entries).toEqual([])
    await bridge.close()
    expect(cfg.replies).toEqual([])
    expect(next.replies).toEqual([])
  } finally {
    gate.held.resolve()
    await bridge.close()
  }
})

test("recovery stops after a held original rejection across disconnect and reconnect", async () => {
  const cfg = await fixture()
  const gate = cfg.hold("reject")
  const entries: string[] = []
  cfg.queued.push(
    {
      id: "req-unknown-held",
      sessionID: "ses-original",
      project: cfg.root,
      command: { action: "propose", id: crypto.randomUUID(), request: { changes: [], sources: [] } },
    },
    { id: "req-after-disconnect", sessionID: "ses-original", project: cfg.root, command: { action: "list" } },
  )
  const bridge = new BrainBridge(cfg.connection, {
    model: async (request) => {
      entries.push(request.id)
      return { action: "list", project: request.project, proposals: [] }
    },
  })
  try {
    cfg.connected()
    await gate.entered.promise
    cfg.disconnect()
    const fresh = cfg.hold("list")
    cfg.connected()
    gate.held.resolve()
    await until(() => cfg.reads.length === 2)
    expect(entries).toEqual([])
    expect(cfg.rejects).toHaveLength(1)
    fresh.held.resolve()
    await until(() => cfg.replies.length === 1)
    await bridge.close()
    expect(cfg.rejects).toHaveLength(1)
    expect(entries).toEqual(["req-after-disconnect"])
    expect(cfg.replies).toEqual([{ result: { action: "list", project: cfg.root, proposals: [] } }])
  } finally {
    gate.held.resolve()
    await bridge.close()
  }
})
