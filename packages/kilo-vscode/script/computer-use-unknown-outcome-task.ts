import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DesktopRequest, KiloClient } from "@kilocode/sdk/v2/client"
import type { SSEPayload } from "../src/services/cli-backend/sdk-sse-adapter"
import type { ConnectionState } from "../src/services/cli-backend/connection-service"
import {
  DesktopBridge,
  type DesktopConnection,
  type DesktopReceiptStore,
} from "../src/services/computer-use/desktop-bridge"
import { DesktopSession, DesktopOutcomeError, type DesktopDriver } from "../src/services/computer-use/desktop-session"

const directory = "C:\\unknown-outcome-fixture"
const key = "raya.computerUse.desktop.actionReceipts.v1"

type Reply = { requestID: string; result?: { observation?: { id: string; target: { windowID: string } } } }
type Rejection = { requestID: string; error?: { receipt?: { outcome?: string } } }

function harness(
  store: DesktopReceiptStore,
  pending: DesktopRequest[],
  effects: string[],
  fail: boolean,
  lost = false,
) {
  const events = new Set<(event: SSEPayload, directory?: string) => void>()
  const states = new Set<(state: ConnectionState, error?: Error) => void>()
  const replies: Reply[] = []
  const rejects: Rejection[] = []
  const driver: DesktopDriver = {
    observe: async () => ({
      windowID: "fixture-window",
      location: "fixture-process|fixture-title|fixture-bounds",
      width: 20,
      height: 10,
      mime: "image/png",
      data: "cG5n",
      timing: { acquisitionMs: 1, preparationMs: 1, totalMs: 2 },
    }),
    windows: async () => [],
    current: async () => ({ windowID: "fixture-window", location: "fixture-process|fixture-title|fixture-bounds" }),
    focus: async () => {},
    perform: async (action) => {
      effects.push(action.operation)
      if (fail) throw new DesktopOutcomeError(action.operation, "Fixture driver lost its native completion response.")
    },
  }
  const client = {
    kilocode: {
      desktop: {
        list: async () => ({ data: pending }),
        reply: async (value: Reply) => {
          replies.push(value)
          return { data: true }
        },
        reject: async (value: Rejection) => {
          rejects.push(value)
          if (lost) return { error: { message: "Fixture backend lost receipt response" } }
          return { data: true }
        },
      },
    },
  } as unknown as KiloClient
  const connection: DesktopConnection = {
    onEvent: (listener) => {
      events.add(listener)
      return () => events.delete(listener)
    },
    onStateChange: (listener) => {
      states.add(listener)
      return () => states.delete(listener)
    },
    getKnownDirectories: () => [directory],
    getClient: () => client,
  }
  const session = new DesktopSession(driver)
  const bridge = new DesktopBridge(connection, session, async () => [await session.observe()], store)
  return {
    bridge,
    replies,
    rejects,
    request: (value: DesktopRequest) => {
      for (const listener of events)
        listener({ type: "kilocode.desktop.requested", properties: value } as SSEPayload, directory)
    },
    reconnect: () => {
      for (const listener of states) listener("connected")
    },
  }
}

export async function runUnknownOutcomeScenario() {
  const root = await mkdtemp(join(tmpdir(), "raya-unknown-outcome-"))
  const path = join(root, "journal.json")
  const effects: string[] = []
  const store: DesktopReceiptStore = {
    get: <T>(name: string) => {
      if (name !== key || !existsSync(path)) return undefined
      return JSON.parse(readFileSync(path, "utf8")) as T
    },
    update: async (name, value) => {
      if (name !== key) throw new Error("Unexpected receipt journal key")
      const next = join(root, "journal.next")
      await writeFile(next, JSON.stringify(value), "utf8")
      await rename(next, path)
    },
  }
  try {
    const first = harness(store, [], effects, true, true)
    const observe: DesktopRequest = {
      id: "fixture-observe",
      sessionID: "fixture-session",
      operation: "observe",
      authorization: { kind: "prompt" },
    }
    first.request(observe)
    await Bun.sleep(20)
    const scene = first.replies[0]?.result?.observation
    if (!scene) throw new Error("Fixture observation was not delivered")
    const click: DesktopRequest = {
      id: "fixture-click",
      sessionID: "fixture-session",
      operation: "click",
      windowID: scene.target.windowID,
      observationID: scene.id,
      sensitive: false,
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.5,
    }
    first.request(click)
    await Bun.sleep(20)
    const before = JSON.parse(await readFile(path, "utf8")) as { items: unknown[] }
    const unknown = first.rejects.filter(
      (item) => item.requestID === click.id && item.error?.receipt?.outcome === "unknown",
    )
    first.bridge.dispose()

    const second = harness(store, [click], effects, false)
    second.reconnect()
    await Bun.sleep(20)
    const after = JSON.parse(await readFile(path, "utf8")) as { items: unknown[]; lastAckAt: number | null }
    const redelivered = second.rejects.filter(
      (item) => item.requestID === click.id && item.error?.receipt?.outcome === "unknown",
    )
    second.request(click)
    await Bun.sleep(20)
    const duplicateRefused = effects.length === 1 && second.rejects.length === 2
    second.bridge.dispose()
    const third = harness(store, [click], effects, false)
    third.reconnect()
    await Bun.sleep(20)
    const recoveredWithoutReceipt = effects.length === 1 && third.rejects.length === 1
    const score = {
      scenario: "ambiguous-native-outcome" as const,
      releaseGateEligible: false as const,
      unknownRecorded: unknown.length === 1 && before.items.length === 1,
      noAutomaticReplay:
        effects.length === 1 && redelivered.length === 1 && duplicateRefused && recoveredWithoutReceipt,
      explicitlyAcknowledged: after.items.length === 0 && typeof after.lastAckAt === "number",
      nativeEffects: effects.length,
      note: "This runs the real DesktopBridge receipt and restart path against a disposable simulated native driver, including lost backend delivery, duplicate request, and a second restart after acknowledgement. It does not prove installed Windows dispatch, host restart, or physical effects.",
    }
    third.bridge.dispose()
    return score
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
