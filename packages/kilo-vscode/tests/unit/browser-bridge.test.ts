// raya_change - Milestone F drive-and-watch bridge regression
import { describe, expect, it } from "bun:test"
import type { BrowserRequest, KiloClient } from "@kilocode/sdk/v2/client"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"
import type { BrowserConnection, BrowserHost } from "../../src/services/browser-automation/browser-bridge"
import { BrowserBridge } from "../../src/services/browser-automation/browser-bridge"

describe("Raya browser bridge", () => {
  it("opens the panel and returns the shared session result for an agent drive request", async () => {
    const actions: BrowserRequest[] = []
    const shown: number[] = []
    let reply: (input: Record<string, unknown>) => void = () => undefined
    const result = new Promise<Record<string, unknown>>((resolve) => {
      reply = resolve
    })
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async (input: Record<string, unknown>) => {
            reply(input)
            return {}
          },
          reject: async () => ({}),
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const host: BrowserHost = {
      show: async () => {
        shown.push(Date.now())
      },
      execute: async (action) => {
        actions.push(action as BrowserRequest)
        return { operation: action.operation, url: "https://example.test", title: "Example" }
      },
    }
    const bridge = new BrowserBridge(connection.value, host)

    connection.event({
      id: "evt_browser",
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_test",
        sessionID: "ses_test",
        operation: "navigate",
        url: "https://example.test",
      },
    })

    expect(await result).toMatchObject({
      requestID: "brr_test",
      directory: "C:\\workspace",
      result: { operation: "navigate", url: "https://example.test" },
    })
    expect(shown).toHaveLength(1)
    expect(actions).toEqual([
      {
        id: "brr_test",
        sessionID: "ses_test",
        operation: "navigate",
        url: "https://example.test",
      },
    ])
    bridge.dispose()
  })

  it("releases browser control when the agent request is cancelled", async () => {
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({}),
          reject: async () => ({}),
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const cancelled: number[] = []
    const bridge = new BrowserBridge(connection.value, {
      show: async () => undefined,
      execute: async (action) => ({ operation: action.operation, url: "about:blank", title: "" }),
      cancel: () => cancelled.push(Date.now()),
    })

    connection.event({
      id: "evt_browser",
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_cancel",
        sessionID: "ses_test",
        operation: "snapshot",
      },
    })
    connection.event({
      id: "evt_cancel",
      type: "kilocode.browser.cancelled",
      properties: {
        requestID: "brr_cancel",
        sessionID: "ses_test",
        reason: "cancelled",
      },
    })

    expect(cancelled).toHaveLength(1)
    bridge.dispose()
  })
})

function harness(client: KiloClient) {
  let event: (event: SSEPayload, directory?: string) => void = () => undefined
  let state: (state: "connecting" | "connected" | "disconnected" | "error") => void = () => undefined
  const value: BrowserConnection = {
    onEvent(listener) {
      event = listener
      return () => undefined
    },
    onStateChange(listener) {
      state = listener
      return () => undefined
    },
    getKnownDirectories: () => ["C:\\workspace"],
    getClient: () => client,
  }
  return {
    value,
    event(input: unknown) {
      event(input as SSEPayload, "C:\\workspace")
    },
    state,
  }
}
