// raya_change - Milestone F drive-and-watch bridge regression
import { describe, expect, it } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import type { BrowserConfirmationCompletion, BrowserRequest, KiloClient } from "@kilocode/sdk/v2/client"
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
  it.each([true, false])("executes proof-backed work only with a first dispatch grant (%s)", async (granted) => {
    const done = Promise.withResolvers<void>()
    const calls = { execute: 0, dispatch: 0, reply: 0, reject: 0, ack: 0 }
    const request = sealed()
    const saved = { completion: undefined as BrowserConfirmationCompletion | undefined }
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          dispatch: async (value: {
            browserDispatchInput: { proof: unknown; invocation: string }
            requestID: string
            directory: string
          }) => {
            calls.dispatch++
            expect(value.browserDispatchInput.proof).toEqual(request.confirmation)
            expect(value.directory).toBe("C:\\workspace")
            if (!granted)
              saved.completion = {
                version: 1,
                identity: request.confirmation.identity,
                invocation: value.browserDispatchInput.invocation,
                ack: "00000000-0000-4000-8000-000000000099",
                requestID: request.id,
                operation: "click",
                outcome: "confirmed",
                startedAt: 1,
                finishedAt: 2,
                resultDigest: "c".repeat(64),
              }
            return { data: { granted } }
          },
          confirm: async (value: { completion: BrowserConfirmationCompletion }) => {
            saved.completion = value.completion
            return { data: value.completion }
          },
          confirmation: async () => ({ data: { completion: saved.completion, pending: false } }),
          reply: async () => {
            calls.reply++
            return { data: true }
          },
          reject: async () => {
            calls.reject++
            return { data: true }
          },
          acknowledge: async () => {
            calls.ack++
            done.resolve()
            return { data: true }
          },
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(connection.value, {
      show: async () => undefined,
      execute: async (action) => {
        calls.execute++
        expect("confirmation" in action).toBe(false)
        expect(action.sensitive).toBe(request.authorization.sensitive)
        return { operation: "click", url: "https://example.test", title: "Confirmed" }
      },
    })
    try {
      connection.event({ type: "kilocode.browser.requested", properties: request })
      await bounded(done.promise)
      expect(calls).toEqual({ execute: granted ? 1 : 0, dispatch: 1, reply: granted ? 1 : 0, reject: 0, ack: 1 })
    } finally {
      bridge.dispose()
    }
  })

  it.each(["confirm", "reply", "changed"] as const)(
    "reconciles a lost proof-backed %s response without repeating native work",
    async (mode) => {
      const done = Promise.withResolvers<void>()
      const seen = Promise.withResolvers<void>()
      const calls = { execute: 0, dispatch: 0, confirm: 0, read: 0, reply: 0, reject: 0, ack: 0 }
      const saved = { completion: undefined as BrowserConfirmationCompletion | undefined, pending: true }
      const replies: unknown[] = []
      const request = sealed()
      const client = {
        kilocode: {
          browser: {
            list: async () => ({ data: [] }),
            dispatch: async () => {
              calls.dispatch++
              return { data: { granted: true } }
            },
            confirm: async (value: { completion: BrowserConfirmationCompletion }) => {
              calls.confirm++
              saved.completion = structuredClone(value.completion)
              if (mode !== "reply") throw new Error("Synthetic dropped confirmation response")
              return { data: value.completion }
            },
            confirmation: async () => {
              calls.read++
              if (!saved.completion) throw new Error("Expected immutable native completion")
              if (mode === "changed" && calls.read === 1) seen.resolve()
              if (mode === "changed" && calls.read === 2) done.resolve()
              return {
                data: {
                  ...(saved.completion
                    ? {
                        dispatch: {
                          version: 1,
                          identity: request.confirmation.identity,
                          invocation: saved.completion.invocation,
                          requestID: request.id,
                          at: 1,
                        },
                      }
                    : {}),
                  completion:
                    mode === "changed" ? { ...saved.completion, resultDigest: "d".repeat(64) } : saved.completion,
                  pending: saved.pending,
                },
              }
            },
            reply: async (value: unknown) => {
              calls.reply++
              replies.push(structuredClone(value))
              saved.pending = false
              if (mode === "reply") throw new Error("Synthetic dropped accepted full reply response")
              return { data: true }
            },
            reject: async () => {
              calls.reject++
              return { data: true }
            },
            acknowledge: async (value: { ack: string }) => {
              calls.ack++
              expect(value.ack).toBe(saved.completion?.ack)
              done.resolve()
              return { data: true }
            },
          },
        },
      } as unknown as KiloClient
      const connection = harness(client)
      const bridge = new BrowserBridge(connection.value, {
        show: async () => undefined,
        execute: async () => {
          calls.execute++
          return { operation: "click", url: "https://example.test", title: "Retained payload" }
        },
      })
      try {
        connection.event({ type: "kilocode.browser.requested", properties: request })
        if (mode === "changed") {
          await bounded(seen.promise)
          await Bun.sleep(0)
          connection.event({ type: "kilocode.browser.requested", properties: request })
        }
        await bounded(done.promise)
        expect(calls.execute).toBe(1)
        expect(calls.dispatch).toBe(1)
        expect(calls.confirm).toBe(1)
        expect(Object.keys(saved.completion ?? {}).sort()).toEqual(
          [
            "version",
            "identity",
            "invocation",
            "ack",
            "requestID",
            "operation",
            "outcome",
            "startedAt",
            "finishedAt",
            "resultDigest",
          ].sort(),
        )
        expect(calls.reject).toBe(0)
        expect(calls.reply).toBe(mode === "changed" ? 0 : 1)
        expect(calls.ack).toBe(mode === "changed" ? 0 : 1)
        expect(calls.read).toBe(mode === "changed" ? 3 : 1)
        if (mode !== "changed")
          expect(replies[0]).toMatchObject({
            requestID: request.id,
            result: { operation: "click", title: "Retained payload", receipt: { outcome: "confirmed" } },
          })
      } finally {
        bridge.dispose()
      }
    },
  )

  it.each(["changed target", "missing proof"] as const)("refuses %s before browser dispatch", async (kind) => {
    const done = Promise.withResolvers<unknown>()
    const calls = { shown: 0, executed: 0, dispatched: 0 }
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          dispatch: async () => {
            calls.dispatched++
            return { data: { granted: true } }
          },
          reply: async () => ({ data: true }),
          reject: async (value: unknown) => {
            done.resolve(value)
            return { data: true }
          },
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(connection.value, {
      show: async () => {
        calls.shown++
      },
      execute: async () => {
        calls.executed++
        return { operation: "click", title: "wrong target" }
      },
    })
    try {
      const request = sealed()
      connection.event(
        {
          type: "kilocode.browser.requested",
          properties:
            kind === "changed target"
              ? { ...request, selector: "#different" }
              : { ...request, confirmation: undefined },
        },
        true,
      )
      const value = await bounded(done.promise)
      expect(value).toMatchObject({
        requestID: request.id,
        error: {
          code: "invalid_request",
          message: expect.stringContaining(
            kind === "changed target" ? "changed after admission" : "lacks durable confirmation",
          ),
        },
      })
      expect(calls).toEqual({ shown: 0, executed: 0, dispatched: 0 })
    } finally {
      bridge.dispose()
    }
  })

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

  it("revalidates immutable authority after showing the browser and before host execution", async () => {
    const shown = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const rejected = Promise.withResolvers<void>()
    const failures: unknown[] = []
    let allowed = true
    let executed = 0
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({ data: true }),
          reject: async (value: unknown) => {
            failures.push(value)
            rejected.resolve()
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
          shown.resolve()
          await release.promise
        },
        execute: async () => {
          executed++
          return { operation: "click", url: "https://example.test", title: "Example" }
        },
      },
      undefined,
      undefined,
      () =>
        allowed
          ? { operation: "authorize", decision: "allow", reason: "Active grant", grantID: "grant_show" }
          : { operation: "authorize", decision: "deny", reason: "Grant revoked while browser opened" },
    )
    try {
      connection.event({
        type: "kilocode.browser.requested",
        properties: {
          id: "brr_show_revoke",
          sessionID: "ses_test",
          operation: "click",
          selector: "#publish",
          authorization: grant("browser", "grant_show"),
        },
      })
      await shown.promise
      allowed = false
      release.resolve()
      await Promise.race([
        rejected.promise,
        Bun.sleep(2_000).then(() => {
          throw new Error("Revoked browser request was not rejected")
        }),
      ])

      expect(executed).toBe(0)
      expect(failures).toContainEqual(
        expect.objectContaining({
          requestID: "brr_show_revoke",
          error: expect.objectContaining({
            message: expect.stringContaining("revoked while browser opened"),
          }),
        }),
      )
      const failure = failures[0] as { error?: { receipt?: unknown } } | undefined
      expect(failure?.error?.receipt).toBeUndefined()
    } finally {
      release.resolve()
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
      expect(failures[1]).toMatchObject({ error: { receipt: { outcome: "unknown" } } })
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
      expect(failures[0]).toMatchObject({ error: { message: expect.stringContaining("before native dispatch") } })
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
      await recovered.promise
      expect(calls).toBe(1)
      expect(replies).toHaveLength(2)
      expect(replies[1]).toEqual(replies[0])
    } finally {
      release.resolve()
      bridge.dispose()
    }
  })

  it("does not replay an acknowledged failed dispatch during recovery", async () => {
    const delivered = Promise.withResolvers<void>()
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
            delivered.resolve()
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
      await Bun.sleep(10)
      expect(calls).toBe(1)
      expect(failures).toHaveLength(1)
    } finally {
      bridge.dispose()
    }
  })

  it("fails before dispatch at receipt capacity without evicting an in-flight request", async () => {
    const release = Promise.withResolvers<void>()
    const capacity = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
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
        if (calls === 1024) entered.resolve()
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
      await entered.promise
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
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      id: "brr_test",
      sessionID: "ses_test",
      ...input,
      origin: { requestID: "brr_test", sessionID: "ses_test", directory: "C:\\workspace" },
    })
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
      version: 2,
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

  it("publishes an interrupted dispatch as unknown after restart without replaying native input", async () => {
    const entered = Promise.withResolvers<void>()
    const hold = Promise.withResolvers<void>()
    const store = memory()
    const calls = { execute: 0, confirm: 0, reject: 0, ack: 0 }
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          confirm: async (input: { completion: BrowserConfirmationCompletion }) => {
            calls.confirm++
            expect(input.completion.outcome).toBe("unknown")
            return { data: input.completion }
          },
          reply: async () => ({ data: true }),
          reject: async () => {
            calls.reject++
            return { data: true }
          },
          acknowledge: async () => {
            calls.ack++
            return { data: true }
          },
        },
      },
    } as unknown as KiloClient
    const firstConnection = harness(client)
    const first = new BrowserBridge(
      firstConnection.value,
      {
        show: async () => undefined,
        execute: async () => {
          calls.execute++
          entered.resolve()
          await hold.promise
          return { operation: "click", tabID: "tab_seen" }
        },
      },
      store,
    )
    firstConnection.event({
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_restart_unknown",
        sessionID: "ses_test",
        operation: "click",
        selector: "#private-selector",
        tabID: "tab_seen",
        authorization: prompt("browser", "tab_seen"),
      },
    })
    await entered.promise
    const saved = store.read() as { version: number; items: Array<{ proof: unknown; invocation: string }> }
    expect(saved.version).toBe(2)
    expect(saved.items[0]).toMatchObject({ proof: { version: 1 }, operation: "click", dispatched: true })
    expect(JSON.stringify(saved)).not.toContain("private-selector")
    first.dispose()
    await Bun.sleep(0)

    const secondConnection = harness(client)
    const second = new BrowserBridge(
      secondConnection.value,
      {
        show: async () => undefined,
        execute: async () => {
          throw new Error("replayed native input")
        },
      },
      store,
    )
    secondConnection.state("connected")
    await bounded(
      (async () => {
        while (calls.ack === 0) await Bun.sleep(1)
      })(),
    )
    expect(calls).toEqual({ execute: 1, confirm: 1, reject: 1, ack: 1 })
    expect(store.read()).toMatchObject({ version: 2, items: [] })
    expect((store.read() as { blocked: string[] }).blocked.length).toBeGreaterThan(0)
    second.dispose()
  })

  it("settles a lost dispatch response as unknown before retiring its proof", async () => {
    const done = Promise.withResolvers<void>()
    const backend = {
      dispatch: undefined as { identity: string; invocation: string; requestID: string; at: number } | undefined,
      completion: undefined as BrowserConfirmationCompletion | undefined,
    }
    const calls = { execute: 0, reject: 0, ack: 0 }
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          dispatch: async (input: {
            requestID: string
            browserDispatchInput: { proof: { identity: string }; invocation: string }
          }) => {
            backend.dispatch = {
              identity: input.browserDispatchInput.proof.identity,
              invocation: input.browserDispatchInput.invocation,
              requestID: input.requestID,
              at: Date.now(),
            }
            throw new Error("Dispatch response lost after durable grant")
          },
          confirmation: async () => ({
            data: { pending: true, dispatch: backend.dispatch, completion: backend.completion },
          }),
          confirm: async (input: { completion: BrowserConfirmationCompletion }) => {
            backend.completion = input.completion
            return { data: input.completion }
          },
          reply: async () => ({ data: true }),
          reject: async () => {
            calls.reject++
            return { data: true }
          },
          acknowledge: async () => {
            calls.ack++
            done.resolve()
            return { data: true }
          },
        },
      },
    } as unknown as KiloClient
    const store = memory()
    const connection = harness(client)
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => undefined,
        execute: async () => {
          calls.execute++
          return { operation: "click", tabID: "tab_seen" }
        },
      },
      store,
    )
    connection.state("connected")
    connection.event({
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_lost_dispatch_response",
        sessionID: "ses_test",
        operation: "click",
        selector: "#save",
        authorization: prompt("browser"),
      },
    })
    await bounded(done.promise)
    expect(calls).toEqual({ execute: 0, reject: 1, ack: 1 })
    expect(backend.completion).toMatchObject({ outcome: "unknown", invocation: backend.dispatch?.invocation })
    await bounded(
      (async () => {
        while ((store.read() as { items: unknown[] }).items.length > 0) await Bun.sleep(1)
      })(),
    )
    expect(store.read()).toMatchObject({ version: 2, items: [] })
    bridge.dispose()
  })

  it("does not settle an active request during a concurrent recovery pass", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const done = Promise.withResolvers<void>()
    const calls = { execute: 0, reject: 0, ack: 0 }
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({ data: true }),
          reject: async () => {
            calls.reject++
            return { data: true }
          },
          acknowledge: async () => {
            calls.ack++
            done.resolve()
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
          entered.resolve()
          await release.promise
        },
        execute: async () => {
          calls.execute++
          return { operation: "click", tabID: "tab_seen" }
        },
      },
      memory(),
    )
    connection.state("connected")
    connection.event({
      type: "kilocode.browser.requested",
      properties: {
        id: "brr_active_recovery",
        sessionID: "ses_test",
        operation: "click",
        selector: "#save",
        authorization: prompt("browser"),
      },
    })
    await entered.promise
    connection.state("connected")
    await Bun.sleep(10)
    expect(calls).toEqual({ execute: 0, reject: 0, ack: 0 })
    release.resolve()
    await bounded(done.promise)
    expect(calls).toEqual({ execute: 1, reject: 0, ack: 1 })
    bridge.dispose()
  })

  it("ignores a late dispatch confirmation when a live owner appears during the read", async () => {
    const entered = Promise.withResolvers<void>()
    const delayed = Promise.withResolvers<unknown>()
    const seed = {
      ...unknown(3),
      proof: { ...sealed().confirmation, identity: "00000000-0000-4000-8000-000000000003", slot: 3 },
      invocation: "00000000-0000-4000-8000-000000000013",
      operation: "click",
      startedAt: 1,
    }
    let confirms = 0
    const store = memory({ version: 2, items: [seed], blocked: [] })
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          confirmation: async () => {
            entered.resolve()
            return delayed.promise
          },
          confirm: async () => {
            confirms++
            return { data: true }
          },
          reply: async () => ({ data: true }),
          reject: async () => ({ data: true }),
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => undefined,
        execute: async () => {
          throw new Error("replayed native input")
        },
      },
      store,
    )
    connection.state("connected")
    await entered.promise
    const state = bridge as unknown as { receipts: Map<string, unknown>; active: Map<string, unknown> }
    state.active.set("brr_saved_3", {
      controller: new AbortController(),
      request: { id: "brr_saved_3", sessionID: "ses_test", operation: "click", selector: "#save" },
      directory: "C:\\workspace",
      startedAt: Date.now(),
      receipt: state.receipts.get("brr_saved_3"),
    })
    delayed.resolve({
      data: {
        pending: true,
        dispatch: {
          version: 1,
          identity: seed.proof.identity,
          invocation: seed.invocation,
          requestID: "brr_saved_3",
          at: 1,
        },
      },
    })
    await Bun.sleep(10)
    expect(confirms).toBe(0)
    expect((store.read() as { items: unknown[] }).items).toHaveLength(1)
    bridge.dispose()
  })

  it("keeps proof when another host dispatches before conditional rejection", async () => {
    const done = Promise.withResolvers<void>()
    const seed = {
      ...unknown(4),
      proof: { ...sealed().confirmation, identity: "00000000-0000-4000-8000-000000000004", slot: 4 },
      invocation: "00000000-0000-4000-8000-000000000014",
      operation: "click",
      startedAt: 1,
    }
    const state = {
      dispatch: undefined as
        | { version: 1; identity: string; invocation: string; requestID: string; at: number }
        | undefined,
      completion: undefined as BrowserConfirmationCompletion | undefined,
    }
    const calls = { conditional: 0, unknown: 0, ack: 0, execute: 0 }
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          confirmation: async () => ({
            data: { pending: true, dispatch: state.dispatch, completion: state.completion },
          }),
          confirm: async (input: { completion: BrowserConfirmationCompletion }) => {
            state.completion = input.completion
            expect(input.completion.outcome).toBe("unknown")
            return { data: input.completion }
          },
          reject: async (input: { proof?: unknown; invocation?: string }) => {
            if (!input.proof) {
              calls.unknown++
              return { data: true }
            }
            calls.conditional++
            expect(input.proof).toEqual(seed.proof)
            expect(input.invocation).toBe(seed.invocation)
            state.dispatch = {
              version: 1,
              identity: seed.proof.identity,
              invocation: seed.invocation,
              requestID: seed.id,
              at: Date.now(),
            }
            return { error: { message: "dispatch already granted" } }
          },
          reply: async () => ({ data: true }),
          acknowledge: async () => {
            calls.ack++
            done.resolve()
            return { data: true }
          },
        },
      },
    } as unknown as KiloClient
    const store = memory({ version: 2, items: [seed], blocked: [] })
    const connection = harness(client)
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => undefined,
        execute: async () => {
          calls.execute++
          throw new Error("replayed native input")
        },
      },
      store,
    )
    connection.state("connected")
    await bounded(done.promise)
    expect(calls).toEqual({ conditional: 1, unknown: 1, ack: 1, execute: 0 })
    expect(state.completion).toMatchObject({ outcome: "unknown", invocation: seed.invocation })
    bridge.dispose()
  })

  it("exact-ACKs a fenced cancellation after its HTTP response is lost", async () => {
    const entered = Promise.withResolvers<void>()
    const done = Promise.withResolvers<void>()
    const seed = {
      ...unknown(5),
      proof: { ...sealed().confirmation, identity: "00000000-0000-4000-8000-000000000005", slot: 5 },
      invocation: "00000000-0000-4000-8000-000000000015",
      operation: "click",
      startedAt: 1,
    }
    const state = { completion: undefined as BrowserConfirmationCompletion | undefined }
    const calls = { reject: 0, ack: 0, execute: 0 }
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          confirmation: async () => ({ data: { pending: !state.completion, completion: state.completion } }),
          reject: async (input: { proof?: { identity: string }; invocation?: string }) => {
            calls.reject++
            expect(input.proof).toEqual(seed.proof)
            expect(input.invocation).toBe(seed.invocation)
            state.completion = {
              version: 1,
              identity: seed.proof.identity,
              invocation: seed.invocation,
              ack: "00000000-0000-4000-8000-000000000099",
              requestID: seed.id,
              operation: "click",
              outcome: "cancelled",
              startedAt: 1,
              finishedAt: 2,
            }
            entered.resolve()
            throw new Error("The cancellation response was lost")
          },
          reply: async () => ({ data: true }),
          acknowledge: async (input: { ack: string }) => {
            expect(input.ack).toBe(state.completion?.ack)
            calls.ack++
            done.resolve()
            return { data: true }
          },
        },
      },
    } as unknown as KiloClient
    const store = memory({ version: 2, items: [seed], blocked: [] })
    const connection = harness(client)
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => undefined,
        execute: async () => {
          calls.execute++
          throw new Error("replayed native input")
        },
      },
      store,
    )
    connection.state("connected")
    await entered.promise
    await Bun.sleep(10)
    expect((store.read() as { items: unknown[] }).items).toHaveLength(1)
    connection.state("connected")
    await bounded(done.promise)
    expect(calls).toEqual({ reject: 1, ack: 1, execute: 0 })
    bridge.dispose()
  })

  it("continues recovering later receipts when an earlier confirmation hangs", async () => {
    const done = Promise.withResolvers<void>()
    const base = sealed().confirmation
    const row = (id: number) => ({
      ...unknown(id),
      proof: { ...base, identity: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, slot: id },
      invocation: `00000000-0000-4000-8000-${String(id + 10).padStart(12, "0")}`,
      operation: "click",
      startedAt: 1,
    })
    const store = memory({ version: 2, items: [row(1), row(2)], blocked: [] })
    const delayed = Promise.withResolvers<unknown>()
    const calls = { first: 0, confirm: 0 }
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          confirmation: async (input: { requestID: string }) => {
            if (input.requestID === "brr_saved_1" && ++calls.first === 1) return delayed.promise
            return { data: { pending: true } }
          },
          confirm: async () => {
            calls.confirm++
            return { data: true }
          },
          reject: async (input: { requestID: string }) => {
            if (input.requestID === "brr_saved_2") done.resolve()
            return { data: true }
          },
          reply: async () => ({ data: true }),
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => undefined,
        execute: async () => {
          throw new Error("replayed native input")
        },
      },
      store,
    )
    connection.state("connected")
    await Promise.race([
      done.promise,
      Bun.sleep(4_000).then(() => {
        throw new Error("Later receipt was starved")
      }),
    ])
    await Bun.sleep(20)
    expect((store.read() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual(["brr_saved_1"])
    delayed.resolve({
      data: {
        pending: true,
        dispatch: {
          version: 1,
          identity: row(1).proof.identity,
          invocation: row(1).invocation,
          requestID: "brr_saved_1",
          at: 1,
        },
      },
    })
    await Bun.sleep(10)
    expect(calls.confirm).toBe(0)
    connection.state("connected")
    await bounded(
      (async () => {
        while ((store.read() as { items: unknown[] }).items.length > 0) await Bun.sleep(1)
      })(),
    )
    expect(calls.first).toBeGreaterThanOrEqual(2)
    bridge.dispose()
  }, 5_000)

  it("redacts legacy receipt messages and locations during journal migration", async () => {
    const done = Promise.withResolvers<void>()
    const seed = unknown(0)
    seed.failure.message = "typed-secret-from-old-host-error"
    const receipt = seed.failure.receipt as typeof seed.failure.receipt & { target?: unknown }
    receipt.target = { surface: "browser", windowID: "tab_seen", location: "https://private.example/secret" }
    const store = memory({ version: 1, items: [seed], blocked: [] })
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => {
            done.resolve()
            return { data: true }
          },
          reject: async () => ({ data: true }),
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const bridge = new BrowserBridge(
      connection.value,
      { show: async () => undefined, execute: async () => ({ operation: "snapshot", snapshot: "" }) },
      store,
    )
    connection.event({
      type: "kilocode.browser.requested",
      properties: { id: "brr_migrate", sessionID: "ses_test", operation: "snapshot", authorization: prompt("observe") },
    })
    await bounded(done.promise)
    const saved = JSON.stringify(store.read())
    expect(saved).toContain('"version":2')
    expect(saved).not.toContain("typed-secret-from-old-host-error")
    expect(saved).not.toContain("private.example")
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
    expect(JSON.stringify(saved)).not.toContain("The click acknowledgement was lost")
    expect(saved.blocked[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(saved).toMatchObject({
      version: 2,
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
    expect(failures[0]).toMatchObject({ requestID: request.id, error: { code: "cancelled" } })

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
    expect(store.read()).toMatchObject({ version: 2, items: [{ id: request.id }], blocked: [] })
    second.dispose()
  })

  it.each([
    ["null", null],
    ["wrong shape", "private-value"],
    ["future version", { version: 3, items: [], blocked: [] }],
    ["oversized receipt list", { version: 1, items: Array.from({ length: 257 }, (_, id) => unknown(id)), blocked: [] }],
    [
      "oversized blocked list",
      {
        version: 1,
        items: [],
        blocked: Array.from({ length: 65 }, (_, id) => id.toString(16).padStart(64, "0")),
      },
    ],
    ["invalid receipt row", { version: 1, items: [{ id: "private-value" }], blocked: [] }],
    [
      "incomplete version two dispatch",
      {
        version: 2,
        items: [{ ...unknown(0), proof: sealed().confirmation, operation: "click", startedAt: 1, dispatched: true }],
        blocked: [],
      },
    ],
    [
      "private target in version two receipt",
      {
        version: 2,
        items: [
          {
            ...unknown(0),
            proof: sealed().confirmation,
            invocation: "00000000-0000-4000-8000-000000000003",
            operation: "click",
            startedAt: 1,
            failure: {
              ...unknown(0).failure,
              receipt: {
                ...unknown(0).failure.receipt,
                target: { surface: "browser", windowID: "tab", location: "private-url" },
              },
            },
          },
        ],
        blocked: [],
      },
    ],
    ["invalid blocked row", { version: 1, items: [], blocked: ["private-value"] }],
    ["duplicate blocked row", { version: 1, items: [], blocked: ["0".repeat(64), "0".repeat(64)] }],
    [
      "conflicting duplicate receipt",
      {
        version: 1,
        items: [unknown(0, "brr_duplicate"), unknown(1, "brr_duplicate")],
        blocked: [],
      },
    ],
  ])("quarantines a %s journal before dispatch", async (_label, seed) => {
    const store = memory(seed)
    const failures: unknown[] = []
    const refused = Promise.withResolvers<void>()
    let shown = 0
    let calls = 0
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({}),
          reject: async (input: unknown) => {
            failures.push(input)
            if (failures.length === 2) refused.resolve()
            return {}
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
          calls++
          return { operation: "snapshot", snapshot: "" }
        },
      },
      store,
    )
    const send = (id: string) =>
      connection.event({
        type: "kilocode.browser.requested",
        properties: {
          id,
          sessionID: "ses_test",
          operation: "snapshot",
          authorization: prompt("observe"),
        },
      })
    try {
      send("brr_corrupt_first")
      while (failures.length < 1) await Bun.sleep(0)
      bridge.resume("C:\\workspace")
      send("brr_corrupt_second")
      await refused.promise
      expect(shown).toBe(0)
      expect(calls).toBe(0)
      expect(failures).toHaveLength(2)
      expect(failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error: {
              code: "invalid_request",
              message: expect.stringMatching(/saved browser safety state.*not dispatched/i),
            },
          }),
        ]),
      )
      expect(JSON.stringify(failures)).not.toContain("private-value")
      expect(store.read()).toEqual(seed)
    } finally {
      bridge.dispose()
    }
  })

  it("quarantines a journal read failure before dispatch", async () => {
    const refused = Promise.withResolvers<unknown>()
    let calls = 0
    const connection = harness({
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({}),
          reject: async (input: unknown) => {
            refused.resolve(input)
            return {}
          },
        },
      },
    } as unknown as KiloClient)
    const store = {
      get: <T>(_key: string): T => {
        throw new Error("private durable read failure")
      },
      update: async () => undefined,
    } satisfies BrowserReceiptStore
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => {
          calls++
        },
        execute: async () => {
          calls++
          return { operation: "snapshot", snapshot: "" }
        },
      },
      store,
    )
    try {
      connection.event({
        type: "kilocode.browser.requested",
        properties: {
          id: "brr_read_failed",
          sessionID: "ses_test",
          operation: "snapshot",
          authorization: prompt("observe"),
        },
      })
      const failure = await refused.promise
      expect(failure).toMatchObject({ error: { message: expect.stringContaining("not dispatched") } })
      expect(JSON.stringify(failure)).not.toContain("private durable read failure")
      expect(calls).toBe(0)
    } finally {
      bridge.dispose()
    }
  })

  it("refuses a new request when all durable receipt slots are unresolved", async () => {
    const seed = { version: 1, items: Array.from({ length: 256 }, (_, id) => unknown(id)), blocked: [] }
    const store = memory(seed)
    const refused = Promise.withResolvers<unknown>()
    let shown = 0
    let calls = 0
    const connection = harness({
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({}),
          reject: async (input: unknown) => {
            refused.resolve(input)
            return {}
          },
        },
      },
    } as unknown as KiloClient)
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => {
          shown++
        },
        execute: async () => {
          calls++
          return { operation: "snapshot", snapshot: "" }
        },
      },
      store,
    )
    try {
      connection.event({
        type: "kilocode.browser.requested",
        properties: {
          id: "brr_capacity_full",
          sessionID: "ses_test",
          operation: "snapshot",
          authorization: prompt("observe"),
        },
      })
      expect(await refused.promise).toMatchObject({
        requestID: "brr_capacity_full",
        error: { message: expect.stringContaining("not dispatched") },
      })
      expect(shown).toBe(0)
      expect(calls).toBe(0)
      const saved = store.read() as { items: { id: string }[] }
      expect(saved.items).toHaveLength(256)
      expect(saved.items[0]?.id).toBe("brr_saved_0")
      expect(saved.items.at(-1)?.id).toBe("brr_saved_255")
    } finally {
      bridge.dispose()
    }
  })

  it("reserves the last durable receipt slot before an active action", async () => {
    const seed = { version: 1, items: Array.from({ length: 255 }, (_, id) => unknown(id)), blocked: [] }
    const store = memory(seed)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const capacity = Promise.withResolvers<void>()
    const persisted = Promise.withResolvers<void>()
    let calls = 0
    const client = {
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({}),
          reject: async (input: { requestID: string }) => {
            if (input.requestID === "brr_reserved_second") {
              capacity.resolve()
              return {}
            }
            persisted.resolve()
            return { error: { message: "offline" } }
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
          calls++
          entered.resolve()
          await release.promise
          throw new BrowserOutcomeError("click", "The click result was lost")
        },
      },
      store,
    )
    const send = (id: string) =>
      connection.event({
        type: "kilocode.browser.requested",
        properties: {
          id,
          sessionID: "ses_test",
          operation: "click",
          selector: "#save",
          authorization: prompt("browser"),
        },
      })
    try {
      send("brr_reserved_active")
      await entered.promise
      send("brr_reserved_second")
      await capacity.promise
      expect(calls).toBe(1)
      release.resolve()
      await persisted.promise
      const saved = store.read() as { items: { id: string }[] }
      expect(saved.items).toHaveLength(256)
      expect(saved.items[0]?.id).toBe("brr_saved_0")
      expect(saved.items.at(-1)?.id).toBe("brr_reserved_active")
    } finally {
      release.resolve()
      bridge.dispose()
    }
  })

  it("refuses a new workspace when all durable blocked-scope slots are occupied", async () => {
    const seed = {
      version: 1,
      items: [],
      blocked: Array.from({ length: 64 }, (_, id) => id.toString(16).padStart(64, "0")),
    }
    const store = memory(seed)
    const refused = Promise.withResolvers<unknown>()
    let calls = 0
    const connection = harness({
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({}),
          reject: async (input: unknown) => {
            refused.resolve(input)
            return {}
          },
        },
      },
    } as unknown as KiloClient)
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => {
          calls++
        },
        execute: async () => {
          calls++
          return { operation: "snapshot", snapshot: "" }
        },
      },
      store,
    )
    try {
      connection.event({
        type: "kilocode.browser.requested",
        properties: {
          id: "brr_scope_full",
          sessionID: "ses_test",
          operation: "snapshot",
          authorization: prompt("observe"),
        },
      })
      expect(await refused.promise).toMatchObject({ error: { message: expect.stringContaining("not dispatched") } })
      expect(calls).toBe(0)
      expect(store.read()).toEqual(seed)
    } finally {
      bridge.dispose()
    }
  })

  it("quarantines later observations after durable receipt persistence fails", async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<unknown>()
    const store = failing()
    let calls = 0
    const connection = harness({
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({}),
          reject: async (input: { requestID: string }) => {
            if (input.requestID === "brr_store_failed") first.resolve()
            else second.resolve(input)
            return {}
          },
        },
      },
    } as unknown as KiloClient)
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => undefined,
        execute: async () => {
          calls++
          throw new BrowserOutcomeError("click", "The click result was lost")
        },
      },
      store,
    )
    try {
      connection.event({
        type: "kilocode.browser.requested",
        properties: {
          id: "brr_store_failed",
          sessionID: "ses_test",
          operation: "click",
          selector: "#save",
          authorization: prompt("browser"),
        },
      })
      await first.promise
      connection.event({
        type: "kilocode.browser.requested",
        properties: {
          id: "brr_after_store_failed",
          sessionID: "ses_test",
          operation: "snapshot",
          authorization: prompt("observe"),
        },
      })
      expect(await second.promise).toMatchObject({
        requestID: "brr_after_store_failed",
        error: { message: expect.stringMatching(/saved browser safety state.*not dispatched/i) },
      })
      expect(calls).toBe(0)
      expect(store.read()).toEqual({ version: 1, items: [], blocked: [] })
    } finally {
      bridge.dispose()
    }
  })

  it("refuses later input after durable safety storage faults", async () => {
    const faulted = Promise.withResolvers<void>()
    const refused = Promise.withResolvers<unknown>()
    const calls: string[] = []
    let shown = 0
    const connection = harness({
      kilocode: {
        browser: {
          list: async () => ({ data: [] }),
          reply: async () => ({}),
          reject: async (input: { requestID: string }) => {
            if (input.requestID === "brr_fault_source") faulted.resolve()
            if (input.requestID === "brr_fault_queued") refused.resolve(input)
            return {}
          },
        },
      },
    } as unknown as KiloClient)
    const bridge = new BrowserBridge(
      connection.value,
      {
        show: async () => {
          shown++
        },
        execute: async (action) => {
          const id = action.origin?.requestID ?? "missing"
          calls.push(id)
          if (id === "brr_fault_source") throw new BrowserOutcomeError("click", "The click result was lost")
          return { operation: "click", tabID: "tab_seen", url: "https://example.test", title: "Example" }
        },
      },
      failing(),
    )
    const send = (id: string) =>
      connection.event({
        type: "kilocode.browser.requested",
        properties: {
          id,
          sessionID: "ses_test",
          operation: "click",
          selector: "#save",
          authorization: prompt("browser"),
        },
      })
    try {
      send("brr_fault_source")
      await faulted.promise
      send("brr_fault_queued")
      expect(await refused.promise).toMatchObject({
        requestID: "brr_fault_queued",
        error: { message: expect.stringContaining("not dispatched") },
      })
      expect(shown).toBe(0)
      expect(calls).toEqual([])
    } finally {
      bridge.dispose()
    }
  })
})

function sealed() {
  return {
    id: "brr_proof",
    sessionID: "ses_test",
    operation: "click" as const,
    selector: "#save",
    authorization: prompt("browser"),
    confirmation: {
      version: 1 as const,
      identity: "00000000-0000-4000-8000-000000000001",
      slot: 0,
      scope: "1c468bd6a69c917b2acf4c54c46e7c1027eb84a9a2dd457e95ebaa6575e19609",
      digest: "e381bd3cc4e08520ab1ee6f67490f4b717a2c3734e908d6c2225c162e5c49f18",
    },
  }
}

async function bounded<T>(body: Promise<T>): Promise<T> {
  const timer = { value: undefined as ReturnType<typeof setTimeout> | undefined }
  try {
    return await Promise.race([
      body,
      new Promise<never>((_resolve, reject) => {
        timer.value = setTimeout(() => reject(new Error("Browser confirmation did not settle")), 2_000)
      }),
    ])
  } finally {
    if (timer.value !== undefined) clearTimeout(timer.value)
  }
}

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

function unknown(id: number, requestID = `brr_saved_${id}`) {
  return {
    id: requestID,
    fingerprint: id.toString(16).padStart(64, "0"),
    failure: {
      code: "disconnected",
      message: "The saved browser outcome is unknown.",
      receipt: {
        version: 1,
        requestID,
        startedAt: 1,
        finishedAt: 2,
        effect: "interact",
        outcome: "unknown",
      },
    },
  }
}

function failing() {
  const value = { version: 1, items: [], blocked: [] }
  return {
    get: <T>(_key: string) => value as T,
    update: async () => {
      throw new Error("durable update failed")
    },
    read: () => value,
  } satisfies BrowserReceiptStore & { read(): unknown }
}

function harness(client: KiloClient) {
  const seals = new Map<string, ReturnType<typeof sealed>["confirmation"]>()
  const operations = new Map<string, BrowserRequest["operation"]>()
  const closed = new Set<string>()
  const browser = client.kilocode.browser as unknown as Record<string, unknown>
  browser.dispatch ??= async () => ({ data: { granted: true } })
  browser.confirm ??= async (input: { completion: BrowserConfirmationCompletion }) => ({ data: input.completion })
  browser.acknowledge ??= async () => ({ data: true })
  const attempts = new Map<
    string,
    { version: 1; identity: string; invocation: string; requestID: string; at: number }
  >()
  const completions = new Map<string, BrowserConfirmationCompletion>()
  const dispatch = browser.dispatch as (input: {
    requestID: string
    browserDispatchInput: { proof: { identity: string }; invocation: string }
  }) => Promise<{ data?: { granted: boolean }; error?: unknown }>
  const confirm = browser.confirm as (input: {
    requestID: string
    completion: BrowserConfirmationCompletion
  }) => Promise<{ data?: unknown; error?: unknown }>
  const reject = browser.reject as (input: {
    requestID: string
    proof?: { identity: string }
    invocation?: string
  }) => Promise<{ data?: unknown; error?: unknown }>
  browser.dispatch = async (input: Parameters<typeof dispatch>[0]) => {
    if (closed.has(input.requestID)) return { data: { granted: false } }
    const response = await dispatch(input)
    if (response.data?.granted)
      attempts.set(input.requestID, {
        version: 1,
        identity: input.browserDispatchInput.proof.identity,
        invocation: input.browserDispatchInput.invocation,
        requestID: input.requestID,
        at: Date.now(),
      })
    return response
  }
  browser.confirm = async (input: Parameters<typeof confirm>[0]) => {
    const response = await confirm(input)
    if (response.data && !response.error) completions.set(input.requestID, input.completion)
    return response
  }
  browser.reject = async (input: Parameters<typeof reject>[0]) => {
    if (input.proof && attempts.has(input.requestID)) return { error: { message: "dispatch already granted" } }
    const response = await reject(input)
    if (input.proof && input.invocation && !response.error) {
      closed.add(input.requestID)
      completions.set(input.requestID, {
        version: 1,
        identity: input.proof.identity,
        invocation: input.invocation,
        ack: randomUUID(),
        requestID: input.requestID,
        operation: (operations.get(input.requestID) ?? "click") as Exclude<BrowserRequest["operation"], "authorize">,
        outcome: "cancelled",
        startedAt: Date.now(),
        finishedAt: Date.now(),
      })
    }
    return response
  }
  const confirmation = browser.confirmation as
    | ((input: { requestID: string }) => Promise<{ data?: Record<string, unknown>; error?: unknown }>)
    | undefined
  browser.confirmation = async (input: { requestID: string }) => {
    const response = confirmation
      ? await confirmation(input)
      : {
          data: {
            pending: true,
            ...(attempts.has(input.requestID) ? { dispatch: attempts.get(input.requestID) } : {}),
          },
        }
    if (!completions.has(input.requestID) || !response.data) return response
    return {
      ...response,
      data: {
        ...response.data,
        completion: response.data.completion ?? completions.get(input.requestID),
        pending: closed.has(input.requestID) ? false : response.data.pending,
      },
    }
  }
  const prepare = (request: unknown) => {
    if (!request || typeof request !== "object" || !("operation" in request) || request.operation === "authorize")
      return request
    operations.set(String("id" in request ? request.id : ""), request.operation as BrowserRequest["operation"])
    if ("confirmation" in request) return request
    const { id, ...body } = request as Record<string, unknown>
    const scoped = path.resolve("C:\\workspace").toLowerCase()
    const digest = (value: unknown) =>
      createHash("sha256")
        .update(
          JSON.stringify(value, (_key, item: unknown) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return item
            return Object.fromEntries(
              Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
            )
          }),
        )
        .digest("hex")
    const proof = seals.get(String(id)) ?? {
      version: 1 as const,
      identity: `00000000-0000-4000-8000-${createHash("sha256").update(String(id)).digest("hex").slice(0, 12)}`,
      slot: 0,
      scope: createHash("sha256").update(scoped).digest("hex"),
      digest: digest(body),
    }
    seals.set(String(id), proof)
    return { ...request, confirmation: proof }
  }
  const listed = browser.list as (() => Promise<{ data?: unknown[] }>) | undefined
  if (listed)
    browser.list = async () => {
      const response = await listed()
      return Array.isArray(response.data) ? { ...response, data: response.data.map(prepare) } : response
    }
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
    event(input: unknown, raw = false) {
      if (raw || !input || typeof input !== "object" || !("properties" in input)) {
        event(input as SSEPayload, "C:\\workspace")
        return
      }
      event(
        {
          ...(input as object),
          properties: prepare(input.properties),
        } as SSEPayload,
        "C:\\workspace",
      )
    },
    state(input: "connecting" | "connected" | "disconnected" | "error") {
      state(input)
    },
  }
}
