// raya_change - Milestone F drive-and-watch bridge regression
import { describe, expect, it } from "bun:test"
import type { BrowserRequest, KiloClient } from "@kilocode/sdk/v2/client"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"
import type { BrowserConnection, BrowserHost } from "../../src/services/browser-automation/browser-bridge"
import { DialogPendingError } from "../../src/services/browser-automation/browser-dialog"
import { BrowserBridge } from "../../src/services/browser-automation/browser-bridge"

describe("Raya browser bridge", () => {
  it("returns the same download transfer after lost acknowledgement without another export click", async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const replies: unknown[] = []
    let count = 0
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async (value: unknown) => {
            replies.push(value)
            if (replies.length === 1) {
              first.resolve()
              throw new Error("lost acknowledgement")
            }
            second.resolve()
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
        count++
        expect(action.origin).toEqual({ requestID: "brr_download", sessionID: "ses_test", directory: "C:\\workspace" })
        return {
          operation: "download",
          transfers: [
            {
              version: 1,
              id: "00000000-0000-4000-8000-000000000001",
              tabID: "tab_seen",
              profile: "profile",
              status: "receiving",
              filename: "report",
              url: "https://example.test/export",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }
      },
    })
    const event = {
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_download",
        sessionID: "ses_test",
        tabID: "tab_seen",
        operation: "download",
        action: "start",
        selector: "#export",
      },
    }
    try {
      connection.event(event)
      await first.promise
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      connection.event(event)
      await second.promise
      expect(count).toBe(1)
      expect(replies[1]).toEqual(replies[0])
    } finally {
      bridge.dispose()
    }
  })
  it("retains dialog-pending failures across lost delivery without replaying the initiating action", async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const failures: unknown[] = []
    let calls = 0
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => {
            throw new Error("Pending action must not be reported complete")
          },
          reject: async (value: unknown) => {
            failures.push(value)
            if (failures.length === 1) {
              first.resolve()
              throw new Error("pending acknowledgement lost")
            }
            second.resolve()
            return {}
          },
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(connection.value, {
      show: async () => undefined,
      execute: async () => {
        calls++
        throw new DialogPendingError(
          { id: "op_seen", tabID: "tab_seen", operation: "click", status: "pending" },
          "dialog_seen",
        )
      },
    })
    const event = {
      type: "kilocode.browser.requested",
      properties: { id: "brr_dialog", sessionID: "ses_test", tabID: "tab_seen", operation: "click", selector: "#save" },
    }
    try {
      connection.event(event)
      await first.promise
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      connection.event(event)
      await second.promise
      expect(calls).toBe(1)
      expect(failures[0]).toMatchObject({
        error: { code: "dialog_pending", message: expect.stringContaining("must not be retried") },
      })
      expect(failures[1]).toEqual(failures[0])
    } finally {
      bridge.dispose()
    }
  })

  it("does not execute recovered work without a local receipt", async () => {
    const done = Promise.withResolvers<void>()
    let calls = 0
    const failures: unknown[] = []
    const client = {
      kilocode: {
        browser: {
          list: async () => ({
            data: [{ id: "brr_old", sessionID: "ses_test", operation: "click", selector: "#save" }],
          }),
          reply: async () => ({}),
          reject: async (input: unknown) => {
            failures.push(input)
            done.resolve()
            return {}
          },
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(connection.value, {
      show: async () => undefined,
      execute: async () => {
        calls++
        throw new Error("Must not execute")
      },
    })
    try {
      connection.state("connected")
      await done.promise
      expect(calls).toBe(0)
      expect(failures[0]).toMatchObject({ error: { message: expect.stringContaining("no local execution receipt") } })
    } finally {
      bridge.dispose()
    }
  })

  it("reports completion uncertainty when retaining a host result fails", async () => {
    const done = Promise.withResolvers<void>()
    const failures: unknown[] = []
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({}),
          reject: async (input: unknown) => {
            failures.push(input)
            done.resolve()
            return {}
          },
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(connection.value, {
      show: async () => undefined,
      execute: async () => ({
        operation: "evaluate",
        url: "https://example.test",
        title: "Saved",
        get output(): string {
          throw new Error("serialization failed")
        },
      }),
    })
    try {
      connection.event({
        type: "kilocode.browser.requested",
        properties: { id: "brr_serialize", sessionID: "ses_test", operation: "evaluate", expression: "save()" },
      })
      await done.promise
      expect(failures[0]).toMatchObject({
        error: { message: expect.stringContaining("action completed but its result could not be retained") },
      })
    } finally {
      bridge.dispose()
    }
  })

  it("retains payload-bound receipts across lost replies and concurrent duplicate requests", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const attempted = Promise.withResolvers<void>()
    const recovered = Promise.withResolvers<void>()
    const collision = Promise.withResolvers<void>()
    let reads = 0
    const request = { id: "brr_once", sessionID: "ses_test", operation: "click", selector: "#save" } as const
    let calls = 0
    const replies: unknown[] = []
    const failures: unknown[] = []
    const client = {
      kilocode: {
        browser: {
          list: async () => {
            if (++reads === 1) throw new Error("connection lost during recovery")
            return { data: [request] }
          },
          reply: async (input: unknown) => {
            replies.push(input)
            if (replies.length === 1) {
              attempted.resolve()
              throw new Error("acknowledgement lost")
            }
            recovered.resolve()
            return {}
          },
          reject: async (input: unknown) => {
            failures.push(input)
            collision.resolve()
            return {}
          },
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(connection.value, {
      show: async () => undefined,
      execute: async () => {
        calls++
        started.resolve()
        await release.promise
        return { operation: "click", url: "https://example.test/saved", title: "Saved" }
      },
    })
    const send = (properties: unknown) => connection.event({ type: "kilocode.browser.requested", properties })
    try {
      send(request)
      await started.promise
      send(request)
      send({ selector: request.selector, operation: request.operation, sessionID: request.sessionID, id: request.id })
      send({ ...request, selector: "#different" })
      await collision.promise
      expect(calls).toBe(1)
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({
        error: { message: expect.stringContaining("reused with different content") },
      })
      release.resolve()
      await attempted.promise
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      connection.state("connected")
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(calls).toBe(1)
      expect(replies).toHaveLength(1)
      connection.state("connected")
      await recovered.promise
      expect(calls).toBe(1)
      expect(replies).toHaveLength(2)
      expect(replies[1]).toEqual(replies[0])
    } finally {
      release.resolve()
      bridge.dispose()
    }
  })

  it("retains dispatched failures instead of executing them again during recovery", async () => {
    const delivered = Promise.withResolvers<void>()
    const repeated = Promise.withResolvers<void>()
    const request = {
      id: "brr_failed_once",
      sessionID: "ses_test",
      operation: "evaluate",
      expression: "mutateThenThrow()",
    } as const
    let calls = 0
    const failures: unknown[] = []
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [request] }),
          reply: async () => ({}),
          reject: async (input: unknown) => {
            failures.push(input)
            ;(failures.length === 1 ? delivered : repeated).resolve()
            return {}
          },
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(connection.value, {
      show: async () => undefined,
      execute: async () => {
        calls++
        throw new Error("The action may have taken effect; inspect the destination")
      },
    })
    try {
      connection.event({ type: "kilocode.browser.requested", properties: request })
      await delivered.promise
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      connection.state("connected")
      await repeated.promise
      expect(calls).toBe(1)
      expect(failures[1]).toEqual(failures[0])
    } finally {
      bridge.dispose()
    }
  })

  it("fails before dispatch at receipt capacity without evicting an in-flight request", async () => {
    const release = Promise.withResolvers<void>()
    const capacity = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    let calls = 0
    let replies = 0
    const failures: unknown[] = []
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => {
            if (++replies === 1024) finished.resolve()
            return {}
          },
          reject: async (input: unknown) => {
            failures.push(input)
            capacity.resolve()
            return {}
          },
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(connection.value, {
      show: async () => undefined,
      execute: async () => {
        calls++
        await release.promise
        return { operation: "click", url: "https://example.test", title: "Saved" }
      },
    })
    const send = (id: number) =>
      connection.event({
        type: "kilocode.browser.requested",
        properties: { id: `brr_capacity_${id}`, sessionID: "ses_test", operation: "click", selector: "#save" },
      })
    try {
      for (let id = 0; id <= 1024; id++) send(id)
      await capacity.promise
      send(0)
      expect(calls).toBe(1024)
      expect(failures[0]).toMatchObject({ error: { message: expect.stringContaining("not dispatched") } })
      release.resolve()
      await finished.promise
      expect(calls).toBe(1024)
    } finally {
      release.resolve()
      bridge.dispose()
    }
  })

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
        origin: { requestID: "forged", sessionID: "forged", directory: "forged" },
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
        origin: { requestID: "brr_test", sessionID: "ses_test", directory: "C:\\workspace" },
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
    state(input: "connecting" | "connected" | "disconnected" | "error") {
      state(input)
    },
  }
}
