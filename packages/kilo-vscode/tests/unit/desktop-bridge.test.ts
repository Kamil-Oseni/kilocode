import { describe, expect, it } from "bun:test"
import type { DesktopRequest, KiloClient } from "@kilocode/sdk/v2/client"
import { DesktopBridge, type DesktopConnection } from "../../src/services/computer-use/desktop-bridge"
import { DesktopSession, type DesktopDriver } from "../../src/services/computer-use/desktop-session"
import type { ConnectionState } from "../../src/services/cli-backend/connection-service"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"

const request: DesktopRequest = { id: "desktop_1", sessionID: "ses_desktop", operation: "observe" }

function setup() {
  const replies: unknown[] = []
  const rejects: unknown[] = []
  const events = new Set<(event: SSEPayload, directory?: string) => void>()
  const states = new Set<(state: ConnectionState, error?: Error) => void>()
  const driver: DesktopDriver = {
    observe: async () => ({
      windowID: "window_1",
      location: "process|title|bounds",
      width: 20,
      height: 10,
      mime: "image/png",
      data: "cG5n",
    }),
    current: async () => ({ windowID: "window_1", location: "process|title|bounds" }),
    perform: async () => undefined,
  }
  const client = {
    kilocode: {
      desktop: {
        list: async () => ({ data: [] }),
        reply: async (input: unknown) => {
          replies.push(input)
          return { data: true }
        },
        reject: async (input: unknown) => {
          rejects.push(input)
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
    getKnownDirectories: () => ["C:\\workspace"],
    getClient: () => client,
  }
  const session = new DesktopSession(driver)
  let shown = 0
  const bridge = new DesktopBridge(connection, session, async () => {
    shown += 1
  })
  return { bridge, events, replies, rejects, shown: () => shown }
}

describe("desktop observation bridge", () => {
  it("delivers one grounded image with a request-bound receipt", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.shown()).toBe(1)
    expect(test.rejects).toEqual([])
    expect(test.replies).toHaveLength(1)
    expect(test.replies[0]).toMatchObject({
      requestID: request.id,
      directory: "C:\\workspace",
      result: {
        operation: "observe",
        width: 20,
        height: 10,
        mime: "image/png",
        data: "cG5n",
        observation: { target: { surface: "desktop", windowID: "window_1", location: "process|title|bounds" } },
        receipt: { requestID: request.id, effect: "observe", outcome: "confirmed" },
      },
    })
    test.bridge.dispose()
  })

  it("redelivers its receipt without capturing the same request twice", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.shown()).toBe(1)
    expect(test.replies).toHaveLength(2)
    test.bridge.dispose()
  })
})
