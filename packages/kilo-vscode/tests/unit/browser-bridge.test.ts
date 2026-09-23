// raya_change - Milestone F drive-and-watch bridge regression
import { describe, expect, it } from "bun:test"
import type { BrowserRequest, KiloClient } from "@kilocode/sdk/v2/client"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"
import type {
  BrowserConnection,
  BrowserHost,
  BrowserReceiptStore,
} from "../../src/services/browser-automation/browser-bridge"
import { DialogPendingError } from "../../src/services/browser-automation/browser-dialog"
import { BrowserBridge } from "../../src/services/browser-automation/browser-bridge"
import { BrowserOutcomeError } from "../../src/services/browser-automation/browser-session"

describe("Raya browser bridge", () => {
  it("negotiates a shared Computer Use grant without showing or executing the browser", async () => {
    const replies: unknown[] = []
    let shown = 0
    let executed = 0
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async (value: unknown) => {
            replies.push(value)
            return { data: true }
          },
          reject: async () => ({ data: true }),
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => {
          shown++
        },
        execute: async () => {
          executed++
          return { operation: "snapshot", snapshot: "" }
        },
      },
      undefined,
      async () => ({
        operation: "authorize",
        decision: "allow",
        reason: "Authorized by shared grant",
        grantID: "grant_test",
      }),
    )
    const request: BrowserRequest = {
      id: "brr_authorize",
      sessionID: "ses_test",
      operation: "authorize",
      surface: "browser",
      action: "browser",
      windowID: "tab_seen",
      sensitive: false,
    }
    try {
      connection.event({ type: "kilocode.browser.requested", properties: request })
      await Bun.sleep(20)
      expect(shown).toBe(0)
      expect(executed).toBe(0)
      expect(replies).toContainEqual({
        requestID: request.id,
        directory: "C:\\workspace",
        result: expect.objectContaining({ operation: "authorize", decision: "allow", grantID: "grant_test" }),
      })
    } finally {
      bridge.dispose()
    }
  })

  it.each(["ask", "deny"] as const)(
    "refuses a shared grant when dispatch revalidation changes to %s",
    async (decision) => {
      const failures: unknown[] = []
      let shown = 0
      let executed = 0
      const client = {
        kilocode: {
          browser: {
            list: async () => ({ data: [] }),
            reply: async () => ({ data: true }),
            reject: async (value: unknown) => {
              failures.push(value)
              return { data: true }
            },
          },
        },
      } as unknown as KiloClient
      const connection = harness(client)
      const bridge = new BrowserBridge(
        connection.value,
        {
          show: async () => {
            shown++
          },
          execute: async () => {
            executed++
            return { operation: "snapshot", snapshot: "" }
          },
        },
        undefined,
        undefined,
        (request) => {
          expect(request.sensitive).toBe("communications")
          return { operation: "authorize", decision, reason: `Computer Use changed to ${decision}` }
        },
      )
      try {
        connection.event({
          type: "kilocode.browser.requested",
          properties: {
            id: "brr_stopped",
            sessionID: "ses_test",
            operation: "click",
            tabID: "tab_seen",
            selector: "#send",
            authorization: grant("browser", "grant_test", "tab_seen", "communications"),
          },
        })
        await Bun.sleep(20)
        expect(shown).toBe(0)
        expect(executed).toBe(0)
        expect(failures).toContainEqual(
          expect.objectContaining({
            requestID: "brr_stopped",
            error: expect.objectContaining({ message: expect.stringContaining(`changed to ${decision}`) }),
          }),
        )
      } finally {
        bridge.dispose()
      }
    },
  )

  it("refuses a lease when local revalidation resolves a different grant", async () => {
    const failures: unknown[] = []
    let executed = 0
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({ data: true }),
          reject: async (value: unknown) => {
            failures.push(value)
            return { data: true }
          },
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => undefined,
        execute: async () => {
          executed++
          return { operation: "snapshot", snapshot: "" }
        },
      },
      undefined,
      undefined,
      () => ({
        operation: "authorize",
        decision: "allow",
        reason: "A replacement grant is active",
        grantID: "grant_replacement",
      }),
    )
    try {
      connection.event({
        type: "kilocode.browser.requested",
        properties: {
          id: "brr_changed_grant",
          sessionID: "ses_test",
          operation: "click",
          selector: "#save",
          authorization: grant("browser", "grant_original"),
        },
      })
      await Bun.sleep(20)
      expect(executed).toBe(0)
      expect(failures).toContainEqual(
        expect.objectContaining({
          requestID: "brr_changed_grant",
          error: expect.objectContaining({ message: expect.stringContaining("changed grants") }),
        }),
      )
    } finally {
      bridge.dispose()
    }
  })

  it("binds staged upload API calls to the authoritative task and preserves lost acknowledgements", async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const requests: unknown[] = []
    const replies: unknown[] = []
    let executions = 0
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          uploadChunk: async (value: unknown) => {
            requests.push(value)
            return { data: { data: "eA==", offset: 0, next: 1 } }
          },
          uploadRelease: async (value: unknown) => {
            requests.push(value)
            return { data: true }
          },
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
    const file = { id: "00000000-0000-4000-8000-000000000002", name: "report.txt", bytes: 1, sha256: "0".repeat(64) }
    const uploadID = "00000000-0000-4000-8000-000000000001"
    const bridge = new BrowserBridge(connection.value, {
      show: async () => undefined,
      execute: async (action) => {
        executions++
        expect(action.uploader).toBeDefined()
        await action.uploader!.chunk(file, 0, AbortSignal.any([]))
        await action.uploader!.release(file)
        return { operation: "upload", uploads: [] }
      },
    })
    const event = {
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_upload",
        sessionID: "ses_test",
        tabID: "tab_seen",
        operation: "upload",
        authorization: prompt("files", "tab_seen", "disclosure"),
        action: "start",
        uploadID,
        selector: "#files",
        destination: "https://example.test/form",
        files: [file],
        origin: { directory: "forged", sessionID: "forged" },
      },
    }
    try {
      connection.event(event)
      await first.promise
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      connection.event(event)
      await second.promise
      expect(executions).toBe(1)
      expect(replies[1]).toEqual(replies[0])
      expect(requests).toEqual([
        { directory: "C:\\workspace", sessionID: "ses_test", uploadID, fileID: file.id, offset: 0 },
        { directory: "C:\\workspace", sessionID: "ses_test", uploadID, fileID: file.id },
      ])
    } finally {
      bridge.dispose()
    }
  })
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
        authorization: prompt("files", "tab_seen"),
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
      properties: {
        id: "brr_dialog",
        sessionID: "ses_test",
        tabID: "tab_seen",
        operation: "click",
        selector: "#save",
        authorization: prompt("browser", "tab_seen"),
      },
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
        properties: {
          id: "brr_serialize",
          sessionID: "ses_test",
          operation: "evaluate",
          expression: "save()",
          authorization: prompt("browser"),
        },
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
    const request = {
      id: "brr_once",
      sessionID: "ses_test",
      operation: "click",
      selector: "#save",
      authorization: prompt("browser"),
    } as const
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
      send({
        selector: request.selector,
        authorization: request.authorization,
        operation: request.operation,
        sessionID: request.sessionID,
        id: request.id,
      })
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
      authorization: prompt("browser"),
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
        properties: {
          id: `brr_capacity_${id}`,
          sessionID: "ses_test",
          operation: "click",
          selector: "#save",
          authorization: prompt("browser"),
        },
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

  it("retires acknowledged receipts so prolonged browser use does not reach capacity", async () => {
    let calls = 0
    let replies = 0
    const failures: unknown[] = []
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => {
            replies++
            return {}
          },
          reject: async (input: unknown) => {
            failures.push(input)
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
        return { operation: "snapshot", url: "https://example.test", title: "Ready" }
      },
    })
    const send = (id: number) =>
      connection.event({
        type: "kilocode.browser.requested",
        properties: {
          id: `brr_long_${id}`,
          sessionID: "ses_test",
          operation: "snapshot",
          authorization: prompt("observe"),
        },
      })
    try {
      for (const start of [0, 256, 512, 768]) {
        for (const id of Array.from({ length: 256 }, (_, offset) => start + offset)) send(id)
        while (replies < start + 256) await Bun.sleep(0)
      }
      send(1024)
      while (replies < 1025) await Bun.sleep(0)
      expect(calls).toBe(1025)
      expect(failures).toEqual([])
    } finally {
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
        authorization: prompt("browser"),
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
        authorization: prompt("observe"),
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

  it("pauses browser control only after a live backend connection is lost", async () => {
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
    connection.state("disconnected")
    expect(cancelled).toEqual([])
    connection.state("connected")
    connection.state("error")
    connection.state("disconnected")
    expect(cancelled).toHaveLength(1)
    connection.state("connected")
    connection.state("disconnected")
    expect(cancelled).toHaveLength(2)
    bridge.dispose()
  })

  it("aborts an active browser result when the live backend disconnects", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const replies: unknown[] = []
    const failures: unknown[] = []
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async (input: unknown) => {
            replies.push(input)
            return {}
          },
          reject: async (input: unknown) => {
            failures.push(input)
            return {}
          },
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const cancelled: number[] = []
    const bridge = new BrowserBridge(connection.value, {
      show: async () => undefined,
      execute: async () => {
        entered.resolve()
        await release.promise
        return { operation: "snapshot", url: "about:blank", title: "" }
      },
      cancel: () => cancelled.push(Date.now()),
    })
    connection.state("connected")
    connection.event({
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_disconnect",
        sessionID: "ses_test",
        operation: "snapshot",
        authorization: prompt("observe"),
      },
    })
    await entered.promise
    connection.state("disconnected")
    release.resolve()
    await Bun.sleep(0)
    expect(cancelled).toHaveLength(1)
    expect(replies).toEqual([])
    expect(failures).toEqual([])
    bridge.dispose()
  })

  it("persists an active action across disconnect and blocks a fresh request after restart", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const store = memory()
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
    let calls = 0
    const first = new BrowserBridge(
      connection.value,
      {
        show: async () => undefined,
        execute: async () => {
          calls++
          entered.resolve()
          await release.promise
          return { operation: "click", tabID: "tab_seen", url: "https://example.test", title: "Example" }
        },
        cancel: () => undefined,
      },
      store,
    )
    connection.state("connected")
    connection.event({
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_disconnect_action",
        sessionID: "ses_test",
        operation: "click",
        tabID: "tab_seen",
        observationID: "obs_seen",
        selector: "#save",
        authorization: prompt("browser", "tab_seen"),
      },
    })
    await entered.promise
    connection.state("disconnected")
    release.resolve()
    await Bun.sleep(0)
    const saved = store.read() as { blocked: string[] }
    expect(saved.blocked).toHaveLength(1)
    expect(saved.blocked[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(saved).toMatchObject({
      version: 1,
      items: [
        {
          id: "brr_disconnect_action",
          failure: { code: "disconnected", receipt: { outcome: "unknown" } },
        },
      ],
    })
    first.dispose()

    const failures: unknown[] = []
    const next = harness({
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({}),
          reject: async (value: unknown) => {
            failures.push(value)
            return {}
          },
        },
      },
    } as unknown as KiloClient)
    const second = new BrowserBridge(
      next.value,
      {
        show: async () => undefined,
        execute: async () => {
          calls++
          return { operation: "click", tabID: "tab_seen", url: "https://example.test", title: "Example" }
        },
      },
      store,
    )
    next.event({
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_after_disconnect",
        sessionID: "ses_test",
        operation: "click",
        tabID: "tab_seen",
        observationID: "obs_after",
        selector: "#save",
        authorization: prompt("browser", "tab_seen"),
      },
    })
    await Bun.sleep(20)
    expect(calls).toBe(1)
    expect(failures[0]).toMatchObject({
      requestID: "brr_after_disconnect",
      error: { message: expect.stringContaining("explicitly resume") },
    })
    second.dispose()
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
          authentication: { source: "live", profileID: "a".repeat(64), login: "unverified" },
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
        authorization: prompt("browser"),
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

  it("returns a versioned receipt bound to the request, target, and observation", async () => {
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
      execute: async () => ({
        operation: "click",
        tabID: "tab_seen",
        url: "https://example.test/form",
        title: "Form",
      }),
    })

    connection.event({
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_grounded",
        sessionID: "ses_test",
        operation: "click",
        tabID: "tab_seen",
        observationID: "obs_seen",
        selector: "#save",
        authorization: prompt("browser", "tab_seen"),
      },
    })
    await done.promise

    expect(replies[0]).toMatchObject({
      requestID: "brr_grounded",
      result: {
        operation: "click",
        receipt: {
          version: 1,
          requestID: "brr_grounded",
          effect: "interact",
          outcome: "confirmed",
          observationID: "obs_seen",
          target: {
            surface: "browser",
            windowID: "tab_seen",
            location: "https://example.test/form",
          },
        },
      },
    })
    bridge.dispose()
  })

  it("persists uncertain actions, blocks fresh IDs, and resumes only after explicit inspection", async () => {
    const store = memory()
    const request = {
      id: "brr_uncertain",
      sessionID: "ses_test",
      operation: "click" as const,
      tabID: "tab_seen",
      observationID: "obs_seen",
      selector: "#save",
      authorization: prompt("browser", "tab_seen"),
    }
    const firstFailures: unknown[] = []
    const firstClient = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({}),
          reject: async (value: unknown) => {
            firstFailures.push(value)
            return { error: { message: "offline" } }
          },
        },
      },
    } as unknown as KiloClient
    const firstConnection = harness(firstClient)
    const paused: string[] = []
    let calls = 0
    const first = new BrowserBridge(
      firstConnection.value,
      {
        show: async () => undefined,
        execute: async () => {
          calls++
          throw new BrowserOutcomeError("click", "The click acknowledgement was lost")
        },
        uncertain: async (_directory, reason) => paused.push(reason),
      },
      store,
    )
    firstConnection.event({ type: "kilocode.browser.requested", properties: request })
    await Bun.sleep(20)
    expect(calls).toBe(1)
    expect(paused[0]).toContain("may have taken effect")
    expect(firstFailures[0]).toMatchObject({
      requestID: request.id,
      error: { receipt: { requestID: request.id, outcome: "unknown" } },
    })
    const saved = store.read() as { blocked: string[] }
    expect(saved.blocked).toHaveLength(1)
    expect(saved.blocked[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(saved).toMatchObject({
      version: 1,
      items: [{ id: request.id, failure: { receipt: { requestID: request.id, outcome: "unknown" } } }],
    })
    first.dispose()

    const failures: unknown[] = []
    const replies: unknown[] = []
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [request] }),
          reply: async (value: unknown) => {
            replies.push(value)
            return {}
          },
          reject: async (value: unknown) => {
            failures.push(value)
            return {}
          },
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const second = new BrowserBridge(
      connection.value,
      {
        show: async () => undefined,
        execute: async (action) => {
          calls++
          return { operation: action.operation, tabID: "tab_seen", url: "https://example.test", title: "Example" }
        },
        uncertain: async (_directory, reason) => paused.push(reason),
      },
      store,
    )
    connection.state("connected")
    await Bun.sleep(20)
    expect(calls).toBe(1)
    expect(failures[0]).toMatchObject({
      requestID: request.id,
      error: { receipt: { requestID: request.id, outcome: "unknown" } },
    })

    connection.event({
      type: "kilocode.browser.requested",
      properties: { ...request, id: "brr_fresh_blocked", observationID: "obs_fresh" },
    })
    await Bun.sleep(20)
    expect(calls).toBe(1)
    expect(failures.at(-1)).toMatchObject({
      requestID: "brr_fresh_blocked",
      error: { message: expect.stringContaining("explicitly resume") },
    })

    second.resume("C:\\workspace")
    await Bun.sleep(0)
    connection.event({
      type: "kilocode.browser.requested",
      properties: { ...request, id: "brr_fresh_resumed", observationID: "obs_resumed" },
    })
    await Bun.sleep(20)
    expect(calls).toBe(2)
    expect(replies.at(-1)).toMatchObject({
      requestID: "brr_fresh_resumed",
      result: { operation: "click", receipt: { outcome: "confirmed" } },
    })
    expect(store.read()).toEqual({ version: 1, items: [], blocked: [] })
    second.dispose()
  })
})

function prompt(
  action: "observe" | "browser" | "scroll" | "files",
  windowID?: string,
  sensitive:
    | false
    | "communications"
    | "financial"
    | "credentials"
    | "software"
    | "system"
    | "deletion"
    | "disclosure"
    | "legal"
    | "publishing" = false,
) {
  return {
    version: 1 as const,
    source: "legacy_prompt" as const,
    sessionID: "ses_test",
    action,
    ...(windowID ? { windowID } : {}),
    sensitive,
  }
}

function grant(
  action: "observe" | "browser" | "scroll" | "files",
  grantID: string,
  windowID?: string,
  sensitive: Parameters<typeof prompt>[2] = false,
) {
  return { ...prompt(action, windowID, sensitive), source: "lease" as const, grantID }
}

function memory(seed?: unknown) {
  let value: unknown = seed
  return {
    get: <T>(_key: string) => value as T | undefined,
    update: async (_key: string, next: unknown) => {
      value = structuredClone(next)
    },
    read: () => value,
  } satisfies BrowserReceiptStore & { read(): unknown }
}

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
