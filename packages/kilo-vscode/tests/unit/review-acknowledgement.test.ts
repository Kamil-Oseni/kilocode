import { describe, expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { KiloProvider } from "../../src/KiloProvider"
import * as vscode from "vscode"
import * as path from "node:path"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { forget, remember } from "../../src/edit-review/attempts"
import { forget as erase, listed, record } from "../../src/edit-review/undone"

describe("host review acknowledgements", () => {
  test("confirmed deletion prunes only matching retry and delivery state", async () => {
    const values = new Map<string, unknown>()
    const state = {
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => {
        values.set(key, value)
      },
    }
    const input = {
      request: "deleted-request",
      session: "session-a",
      directory: process.cwd(),
      action: "keep" as const,
      expected: { "file.ts": "revision" },
    }
    await remember(state, input)
    await remember(state, { ...input, session: "session-a-other", request: "retained-request" })
    await record(state, "session-a", { "gone.ts": "undone" })
    await record(state, "session-a-other", { "gone.ts": "kept" })
    const provider = new KiloProvider({} as never, { pruneSession: () => {} } as never)
    const host = provider as unknown as {
      extensionContext: { workspaceState: typeof state }
      deliveries: Map<string, () => Promise<void>>
      pruneDeletedSession(session: string): void
    }
    host.extensionContext = { workspaceState: state }
    host.deliveries.set("session-a\0request", async () => {})
    host.deliveries.set("session-a-other\0request", async () => {})
    host.pruneDeletedSession("session-a")
    await forget(state, "unrelated")
    await erase(state, "unrelated")
    expect(host.deliveries.has("session-a\0request")).toBe(false)
    expect(host.deliveries.has("session-a-other\0request")).toBe(true)
    expect(JSON.stringify([...values.values()])).not.toContain("deleted-request")
    expect(JSON.stringify([...values.values()])).toContain("retained-request")
    expect(listed(state, "session-a")).toEqual({})
    expect(listed(state, "session-a-other")).toEqual({ "gone.ts": "kept" })
  })

  for (const action of ["keep", "undo"] as const) {
    test(`${action} retains the persisted ID until the matching webview acknowledges delivery`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "raya-delivery-"))
      const file = path.join(directory, "workspace.json")
      await writeFile(file, "{}")
      const bodies: unknown[] = []
      const client = createKiloClient({
        baseUrl: "http://review.test",
        fetch: async (input) => {
          bodies.push(await (input as Request).json())
          return Response.json({ id: "session-a", title: "Task", time: { created: 1, updated: 2 } })
        },
      })
      const open = async () => {
        const values = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
        const state = {
          get: (key: string) => values[key],
          update: async (key: string, value: unknown) => {
            await writeFile(file, JSON.stringify({ ...values, [key]: value }))
            values[key] = value
          },
        }
        const provider = new KiloProvider({} as never, { getClient: () => client } as never)
        const messages: unknown[] = []
        provider.postMessage = (message) => {
          messages.push(message)
        }
        const host = provider as unknown as {
          extensionContext: { workspaceState: typeof state }
          reviewAction(
            sid: string,
            action: "keep" | "undo",
            request: string,
            files: string[],
            expected: Record<string, string>,
          ): Promise<void>
          checkpoint(sid: string, run: () => Promise<void>): void
          handleCheckpointMessage(message: unknown): boolean
          scheduleReview(): void
          getWorkspaceDirectory(): string
        }
        host.extensionContext = { workspaceState: state }
        host.scheduleReview = () => {}
        host.getWorkspaceDirectory = () => directory
        const operations: Promise<void>[] = []
        host.checkpoint = (_sid, run) => {
          operations.push(run())
        }
        return { host, messages, operations }
      }
      try {
        const first = await open()
        const expected = { "file.ts": "1".repeat(64) }
        await first.host.reviewAction("session-a", action, "original", ["file.ts"], expected)
        expect(await readFile(file, "utf8")).toContain("original")
        const restarted = await open()
        await restarted.host.reviewAction("session-a", action, "restart", ["file.ts"], expected)
        expect(bodies).toEqual([
          { files: ["file.ts"], expected, requestID: "original" },
          { files: ["file.ts"], expected, requestID: "original" },
        ])
        expect(restarted.messages).toContainEqual({
          type: "editReviewResult",
          sessionID: "session-a",
          requestID: "restart",
          action,
          refreshOnly: true,
        })
        for (const identity of [
          { sessionID: "other", requestID: "restart" },
          { sessionID: "session-a", requestID: "other" },
        ]) {
          expect(restarted.host.handleCheckpointMessage({ type: "editReviewAcknowledged", ...identity })).toBe(true)
        }
        await Promise.all(restarted.operations)
        expect(await readFile(file, "utf8")).toContain("original")
        expect(
          restarted.host.handleCheckpointMessage({
            type: "editReviewAcknowledged",
            sessionID: "session-a",
            requestID: "restart",
          }),
        ).toBe(true)
        await Promise.all(restarted.operations)
        expect(await readFile(file, "utf8")).not.toContain("original")
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    test(`${action} reports unsaved bulk review conflicts without sending a request`, async () => {
      let sent = 0
      const client = createKiloClient({
        baseUrl: "http://review.test",
        fetch: async () => {
          sent++
          return Response.json({ id: "session-a" })
        },
      })
      const provider = new KiloProvider({} as never, { getClient: () => client } as never)
      const messages: unknown[] = []
      provider.postMessage = (message) => {
        messages.push(message)
      }
      const host = provider as unknown as {
        reviewAction(
          sid: string,
          action: "keep" | "undo",
          request: string,
          files: undefined,
          expected: Record<string, string>,
        ): Promise<void>
        getWorkspaceDirectory(): string
        scheduleReview(): void
      }
      host.getWorkspaceDirectory = () => process.cwd()
      host.scheduleReview = () => {}
      const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
      const document = { uri: vscode.Uri.file(path.resolve("file.ts")), isDirty: true } as vscode.TextDocument
      documents.push(document)
      try {
        await host.reviewAction("session-a", action, "request-a", undefined, { "file.ts": "0".repeat(64) })
        expect(sent).toBe(0)
        expect(messages).toContainEqual({
          type: "editReviewResult",
          sessionID: "session-a",
          requestID: "request-a",
          action,
          error: "Save or revert unsaved changes in file.ts before reviewing it.",
        })
      } finally {
        documents.splice(documents.indexOf(document), 1)
      }
    })

    test(`${action} dispatches an inline file request with exact scope and revisions`, async () => {
      const bodies: unknown[] = []
      const client = createKiloClient({
        baseUrl: "http://review.test",
        fetch: async (input) => {
          bodies.push(await (input as Request).json())
          return Response.json({ id: "session-a", title: "Task", time: { created: 1, updated: 2 } })
        },
      })
      const provider = new KiloProvider({} as never, { getClient: () => client } as never)
      const messages: unknown[] = []
      provider.postMessage = (message) => {
        messages.push(message)
      }
      const operations: Promise<void>[] = []
      const host = provider as unknown as {
        checkpoint(sid: string, run: () => Promise<void>): void
        scheduleReview(): void
        handleCheckpointMessage(message: unknown): boolean
      }
      host.scheduleReview = () => {}
      host.checkpoint = (_sid, run) => {
        operations.push(run())
      }
      const expected = { "src/file.ts": "1".repeat(64) }
      expect(
        host.handleCheckpointMessage({
          type: action === "keep" ? "editReviewKeepAll" : "discardSessionChanges",
          sessionID: "session-a",
          requestID: "inline-a",
          files: ["src/file.ts"],
          expected,
        }),
      ).toBe(true)
      await Promise.all(operations)
      expect(bodies).toEqual([{ files: ["src/file.ts"], expected, requestID: "inline-a" }])
      expect(messages).toContainEqual({
        type: "editReviewResult",
        sessionID: "session-a",
        requestID: "inline-a",
        action,
      })
    })

    test(`${action} reports HTTP failures without accepting editor revisions`, async () => {
      const client = createKiloClient({
        baseUrl: "http://review.test",
        fetch: async () => Response.json({ message: "failure" }, { status: 500 }),
      })
      const provider = new KiloProvider({} as never, { getClient: () => client } as never)
      const messages: unknown[] = []
      let accepted = 0
      provider.postMessage = (message) => {
        messages.push(message)
      }
      provider.setInEditorReview({
        refresh() {},
        dismissAll() {},
        reset() {},
        capture: () => () => {
          accepted++
        },
      })
      const host = provider as unknown as {
        reviewAction(sid: string, action: "keep" | "undo", request: string): Promise<void>
        scheduleReview(): void
      }
      host.scheduleReview = () => {}
      await host.reviewAction("session-a", action, "request-a")
      expect(accepted).toBe(0)
      expect(messages).toContainEqual({
        type: "editReviewResult",
        sessionID: "session-a",
        requestID: "request-a",
        action,
        error: `Could not ${action} file changes. Review remains available.`,
      })
    })

    test(`${action} publishes success and accepts captured editor revisions only after the response`, async () => {
      let respond: ((response: Response) => void) | undefined
      const bodies: unknown[] = []
      const client = createKiloClient({
        baseUrl: "http://review.test",
        fetch: async (input) => {
          bodies.push(await (input as Request).json())
          return new Promise<Response>((resolve) => {
            respond = resolve
          })
        },
      })
      const provider = new KiloProvider({} as never, { getClient: () => client } as never)
      const messages: unknown[] = []
      let accepted = 0
      provider.postMessage = (message) => {
        messages.push(message)
      }
      provider.setInEditorReview({
        refresh() {},
        dismissAll() {},
        reset() {},
        capture: () => () => {
          accepted++
        },
      })
      const host = provider as unknown as {
        reviewAction(
          sid: string,
          action: "keep" | "undo",
          request: string,
          files?: string[],
          expected?: Record<string, string>,
        ): Promise<void>
        scheduleReview(): void
      }
      host.scheduleReview = () => {}
      const expected = { "file.ts": "0".repeat(64) }
      const operation = host.reviewAction("session-a", action, "request-a", undefined, expected)
      for (let attempt = 0; !respond && attempt < 100; attempt++) await Bun.sleep(1)
      expect(respond).toBeDefined()
      expect(bodies).toEqual([{ expected, requestID: "request-a" }])
      expect(messages).toEqual([])
      expect(accepted).toBe(0)
      respond!(Response.json({ id: "session-a", title: "Task", time: { created: 1, updated: 2 } }))
      await operation
      expect(accepted).toBe(1)
      expect(messages).toContainEqual({
        type: "editReviewResult",
        sessionID: "session-a",
        requestID: "request-a",
        action,
      })
    })
  }

  test("successful Undo hydrates after the file leaves the live diff and reopens when it returns", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "raya-undone-host-"))
    const file = path.join(directory, "workspace.json")
    await writeFile(file, "{}")
    let live = false
    const client = createKiloClient({
      baseUrl: "http://review.test",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        if (new URL(request.url).pathname.endsWith("/diff")) {
          if (!live) return Response.json([])
          return Response.json([
            { file: "file.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, reviewed: "" },
          ])
        }
        return Response.json({ id: "session-a", title: "Task", time: { created: 1, updated: 2 } })
      },
    })
    const values = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    const state = {
      get: (key: string) => values[key],
      update: async (key: string, value: unknown) => {
        await writeFile(file, JSON.stringify({ ...values, [key]: value }))
        values[key] = value
      },
    }
    const provider = new KiloProvider({} as never, { getClient: () => client } as never)
    const messages: unknown[] = []
    provider.postMessage = (message) => {
      messages.push(message)
    }
    const host = provider as unknown as {
      extensionContext: { workspaceState: typeof state }
      reviewAction(
        sid: string,
        action: "keep" | "undo",
        request: string,
        files: string[],
        expected: Record<string, string>,
      ): Promise<void>
      refreshReview(sessionID?: string): Promise<void>
      scheduleReview(): void
      getWorkspaceDirectory(): string
    }
    host.extensionContext = { workspaceState: state }
    host.scheduleReview = () => {}
    host.getWorkspaceDirectory = () => directory
    const expected = { "file.ts": "1".repeat(64) }
    try {
      await host.reviewAction("session-a", "undo", "original", ["file.ts"], expected)
      await host.refreshReview("session-a")
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "reviewStatsLoaded",
          sessionID: "session-a",
          expected: {},
          accepted: expected,
        }),
      )
      expect(listed(state, "session-a")).toEqual(expected)
      live = true
      await host.refreshReview("session-a")
      const loaded = messages.filter(
        (message): message is { type: string; accepted?: Record<string, string> } =>
          !!message && typeof message === "object" && "type" in message && message.type === "reviewStatsLoaded",
      )
      expect(loaded.at(-1)?.accepted).toEqual({})
      expect(listed(state, "session-a")).toEqual({})
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
