// raya_change - Milestone F drive-and-watch bridge regression
import { describe, expect, it } from "bun:test"
import type { BrowserRequest, KiloClient } from "@kilocode/sdk/v2/client"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"
import type { BrowserConnection, BrowserHost } from "../../src/services/browser-automation/browser-bridge"
import { BrowserBridge } from "../../src/services/browser-automation/browser-bridge"

describe("Raya browser bridge", () => {
  it.each([
    { operation: "navigate" as const, url: "https://example.test" },
    { operation: "click" as const, selector: { kind: "role" as const, role: "button", name: "Save", scope: "#form" } },
    {
      operation: "type" as const,
      selector: { kind: "label" as const, text: "Email" },
      text: "person@example.test",
      submit: false,
    },
    { operation: "select" as const, selector: { kind: "testid" as const, value: "choice" }, values: ["b"] },
  ])("opens the panel and preserves an agent drive request: $operation", async (input) => {
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
        ...input,
      },
    })

    expect(await result).toMatchObject({
      requestID: "brr_test",
      directory: "C:\\workspace",
      result: { operation: input.operation, url: "https://example.test" },
    })
    expect(shown).toHaveLength(1)
    expect(actions).toEqual([
      {
        id: "brr_test",
        sessionID: "ses_test",
        ...input,
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

  it("returns a structured smoke report through the CLI bridge", async () => {
    const actions: BrowserRequest[] = []
    const replies: Record<string, unknown>[] = []
    const done = Promise.withResolvers<void>()
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async (input: Record<string, unknown>) => {
            replies.push(input)
            done.resolve()
            return {}
          },
          reject: async () => ({}),
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(connection.value, {
      show: async () => undefined,
      execute: async (action) => {
        actions.push(action as BrowserRequest)
        if (action.operation !== "smoke") throw new Error("Expected smoke action")
        return {
          operation: "smoke",
          runID: "run_green",
          name: action.name,
          mode: action.mode,
          passed: true,
          startedAt: 1,
          finishedAt: 2,
          artifact: "report.json",
          authState: "auth.json",
          steps: [
            {
              id: "dashboard",
              title: "Dashboard",
              passed: true,
              screenshot: "dashboard.png",
              assertions: [{ kind: "network", passed: true, expected: "/health 200", actual: "200" }],
            },
          ],
          network: [{ url: "/health", status: 200 }],
          console: [],
        }
      },
    })

    connection.event({
      id: "evt_smoke",
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_smoke",
        sessionID: "ses_test",
        operation: "smoke",
        name: "sample-app",
        mode: "scripted",
        steps: [
          {
            id: "dashboard",
            title: "Dashboard",
            assertions: [
              { kind: "visible", selector: "#welcome" },
              { kind: "network", url: "/health", status: 200 },
            ],
          },
        ],
      },
    })
    await done.promise

    expect(actions[0]).toMatchObject({ operation: "smoke", name: "sample-app" })
    expect(replies[0]).toMatchObject({
      requestID: "brr_smoke",
      result: { operation: "smoke", passed: true, artifact: "report.json" },
    })
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
