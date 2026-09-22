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
  const actions: unknown[] = []
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
    perform: async (action) => {
      actions.push(action)
    },
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
  let observed = 0
  const bridge = new DesktopBridge(connection, session, async () => {
    observed += 1
    return session.observe()
  })
  return { bridge, events, replies, rejects, actions, observed: () => observed }
}

describe("desktop observation bridge", () => {
  it("delivers one grounded image with a request-bound receipt", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.observed()).toBe(1)
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
    expect(test.observed()).toBe(1)
    expect(test.replies).toHaveLength(2)
    test.bridge.dispose()
  })

  it("dispatches a click once against the exact fresh observation", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    const click: DesktopRequest = {
      id: "desktop_2",
      sessionID: "ses_desktop",
      operation: "click",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([expect.objectContaining({ operation: "pointer", action: "click", x: 0.5, y: 0.25 })])
    expect(test.replies[1]).toMatchObject({
      requestID: click.id,
      result: { operation: "click", receipt: { effect: "interact", outcome: "confirmed" } },
    })
    for (const listener of test.events)
      listener(
        { type: "kilocode.desktop.requested", properties: { ...click, id: "desktop_3" } } as SSEPayload,
        "C:\\workspace",
      )
    await Bun.sleep(20)
    expect(test.actions).toHaveLength(1)
    expect(test.rejects).toHaveLength(1)
    test.bridge.dispose()
  })
})
