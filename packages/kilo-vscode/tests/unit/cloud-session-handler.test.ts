import { describe, expect, it } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import {
  handleImportAndSend,
  handleRequestCloudSessionData,
  handleResetCloudContinuation,
  type CloudSessionContext,
} from "../../src/kilo-provider/handlers/cloud-session"
import type { CloudContinuationRecord } from "../../src/services/cloud-continuation-journal"

function fixture() {
  const calls: { path: string; directory: string | null; body: unknown }[] = []
  const sent: Record<string, unknown>[] = []
  const journal = new Map<string, CloudContinuationRecord>()
  const state = {
    directory: "/repo",
    generation: 0,
    fail: false,
    conflict: false,
    previewFail: false,
    sending: false,
    imported: () => {},
    saving: () => {},
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      calls.push({
        path,
        directory: new URL(request.url).searchParams.get("directory"),
        body: request.method === "POST" ? await request.json() : undefined,
      })
      if (path.endsWith("/import")) {
        state.imported()
        if (state.conflict) return Response.json({ error: "changed" }, { status: 409 })
        return state.fail
          ? Response.json({ error: "lost acknowledgement" }, { status: 503 })
          : Response.json({ id: "local", title: "Copy", time: { created: 1, updated: 1 } })
      }
      if (path.includes("/session/local/")) return new Response(null, { status: state.sending ? 503 : 204 })
      return state.previewFail
        ? Response.json({ error: "offline" }, { status: 503 })
        : Response.json({ info: { title: "Cloud original", time: { created: 1, updated: 7 } }, messages: [] })
    },
  })
  const ctx: CloudSessionContext = {
    client: createKiloClient({ baseUrl: server.url.origin }),
    get generation() {
      return state.generation
    },
    continuations: new Map(),
    currentSession: null,
    trackedSessionIds: new Set(),
    journal: {
      get: async (key) => journal.get(key),
      claim: async (key, record) => {
        state.saving()
        const found = journal.get(key)
        if (found) return { acquired: false, record: found }
        journal.set(key, record)
        return { acquired: true, record }
      },
      complete: async (key, claim, sessionID) => {
        const found = journal.get(key)
        if (!found || found.claim !== claim) throw new Error("claim changed")
        journal.set(key, { ...found, sessionID })
      },
      clear: async (key, claim) => {
        const found = journal.get(key)
        if (!found || found.claim !== claim) return false
        journal.delete(key)
        return true
      },
    },
    connectionService: { recordMessageSessionId() {} },
    postMessage: (message) => sent.push(message as Record<string, unknown>),
    getWorkspaceDirectory: () => state.directory,
    gatherEditorContext: async () => ({}),
  }
  const preview = () => handleRequestCloudSessionData(ctx, "cloud", "request")
  const send = () =>
    handleImportAndSend(
      ctx,
      "cloud",
      "Continue",
      "message",
      undefined,
      undefined,
      undefined,
      undefined,
      [{ mime: "image/png", url: "data:image/png;base64,AA==", filename: "draft.png" }],
      undefined,
      undefined,
      undefined,
      ctx.continuations.get("cloud")?.id,
    )
  return { ctx, calls, sent, state, preview, send, close: () => server.stop(true) }
}

describe("cloud continuation through the real SDK HTTP transport", () => {
  it("shows a correlated preview and imports into its captured destination exactly once", async () => {
    const f = fixture()
    try {
      await f.preview()
      expect(f.sent[0]).toMatchObject({
        type: "cloudSessionDataLoaded",
        requestID: "request",
        continuation: { directory: "/repo", status: "preview" },
      })
      await f.send()
      await f.send()
      expect(f.calls.filter((call) => call.path.endsWith("/import"))).toEqual([
        {
          path: "/kilo/cloud/session/import",
          directory: "/repo",
          body: { sessionId: "cloud", expectedUpdated: 7 },
        },
      ])
      expect(f.calls.filter((call) => call.path.includes("prompt_async"))).toHaveLength(1)
      expect(f.ctx.currentSession?.id).toBe("local")
      f.ctx.continuations.clear()
      await f.preview()
      expect(f.sent.at(-1)).toMatchObject({ continuation: { status: "imported", sessionID: "local" } })
      expect(f.sent.some((message) => message.type === "cloudSessionImported")).toBe(true)
    } finally {
      f.close()
    }
  })

  it("rejects a changed workspace before import", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.directory = "/different"
      await f.send()
      expect(f.calls).toHaveLength(1)
      expect(f.sent.at(-1)).toMatchObject({
        type: "sendMessageFailed",
        sessionID: "cloud:cloud",
        text: "Continue",
        files: [{ filename: "draft.png" }],
      })
    } finally {
      f.close()
    }
  })

  it("rejects a cloud revision conflict before treating an import as ambiguous", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.conflict = true
      await f.send()
      expect(f.calls.filter((call) => call.path.endsWith("/import"))).toHaveLength(1)
      expect(f.ctx.continuations.get("cloud")?.status).toBe("preview")
      expect(f.sent.at(-1)).toMatchObject({
        type: "sendMessageFailed",
        error: "The cloud session changed after this preview. Reopen it before creating a local copy.",
      })
      expect(await f.ctx.journal.get(JSON.stringify(["cloud", "/repo"]))).toBeUndefined()
    } finally {
      f.close()
    }
  })

  it("fences a workspace change while import is in flight and retains its known local copy", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.imported = () => {
        f.state.directory = "/different"
      }
      await f.send()
      expect(f.ctx.currentSession).toBeNull()
      expect(f.calls).toHaveLength(2)
      expect(f.ctx.continuations.get("cloud")).toMatchObject({ status: "imported", session: { id: "local" } })
      expect(f.sent.some((message) => message.type === "cloudSessionImported")).toBe(false)
    } finally {
      f.close()
    }
  })

  it("never retries an unacknowledged import after reopening or reconstructing host state", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.fail = true
      await f.send()
      await f.preview()
      await f.send()
      f.ctx.continuations.clear()
      await f.preview()
      await f.send()
      expect(f.calls.filter((call) => call.path.endsWith("/import"))).toHaveLength(1)
      expect(f.ctx.continuations.get("cloud")?.status).toBe("uncertain")
    } finally {
      f.close()
    }
  })

  it("retains recovery actions when the cloud preview cannot be refreshed", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.fail = true
      await f.send()
      f.ctx.continuations.clear()
      f.state.previewFail = true
      await f.preview()
      expect(f.sent.at(-2)).toMatchObject({
        type: "cloudSessionDataLoaded",
        title: "Cloud session recovery",
        continuation: { status: "uncertain", revision: 7 },
      })
      expect(f.sent.at(-1)).toMatchObject({ type: "cloudSessionImportFailed" })
    } finally {
      f.close()
    }
  })

  it("requires an explicit reset before a user can create a new copy after an uncertain import", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.fail = true
      await f.send()
      const ticket = f.ctx.continuations.get("cloud")!
      f.state.fail = false
      await handleResetCloudContinuation(f.ctx, "cloud", ticket.id, "reset-request")
      expect(f.sent.at(-1)).toMatchObject({
        type: "cloudSessionDataLoaded",
        requestID: "reset-request",
        continuation: { status: "preview", revision: 7 },
      })
      await f.send()
      expect(f.calls.filter((call) => call.path.endsWith("/import"))).toHaveLength(2)
      expect(f.ctx.currentSession?.id).toBe("local")
    } finally {
      f.close()
    }
  })

  it("retains an uncertain reservation when the destination changes before reset", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.fail = true
      await f.send()
      const ticket = f.ctx.continuations.get("cloud")!
      f.state.directory = "/different"
      await handleResetCloudContinuation(f.ctx, "cloud", ticket.id, "reset-request")
      expect(await f.ctx.journal.get(JSON.stringify(["cloud", "/repo"]))).toMatchObject({ claim: ticket.id })
      expect(f.sent.at(-1)).toMatchObject({
        type: "cloudSessionImportFailed",
        error: "The destination changed. The recovery reservation was retained; reopen the cloud preview.",
      })
    } finally {
      f.close()
    }
  })

  it("distinguishes import success followed by send failure and restores to the local session", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.sending = true
      await f.send()
      expect(f.sent.at(-2)).toMatchObject({ type: "cloudSessionImported", session: { id: "local" } })
      expect(f.sent.at(-1)).toMatchObject({
        type: "sendMessageFailed",
        sessionID: "local",
        draftID: "local",
        text: "Continue",
        files: [{ filename: "draft.png" }],
      })
      expect(f.ctx.continuations.get("cloud")?.status).toBe("imported")
    } finally {
      f.close()
    }
  })

  it("does not mutate when recovery storage fails", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.saving = () => {
        throw new Error("disk unavailable")
      }
      await f.send()
      expect(f.calls).toHaveLength(1)
      expect(f.ctx.continuations.get("cloud")?.status).toBe("preview")
    } finally {
      f.close()
    }
  })
  it("rejects a backend generation change even when the workspace path is unchanged", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.generation++
      await f.send()
      expect(f.calls).toHaveLength(1)
    } finally {
      f.close()
    }
  })

  it("clears the unused journal when context changes while saving before dispatch", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.saving = () => {
        f.state.generation++
      }
      await f.send()
      expect(f.calls).toHaveLength(1)
      f.ctx.continuations.clear()
      await f.preview()
      expect(f.ctx.continuations.get("cloud")?.status).toBe("preview")
    } finally {
      f.close()
    }
  })
  it("allows a separately disclosed destination while retaining the first destination's journal", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.fail = true
      await f.send()
      f.state.directory = "/other"
      await f.preview()
      expect(f.sent.at(-1)).toMatchObject({ continuation: { directory: "/other", status: "preview" } })
      f.state.fail = false
      await f.send()
      expect(f.calls.filter((call) => call.path.endsWith("/import"))).toHaveLength(2)
      f.state.directory = "/repo"
      f.state.generation++
      await f.preview()
      expect(f.sent.at(-1)).toMatchObject({ continuation: { directory: "/repo", status: "uncertain" } })
    } finally {
      f.close()
    }
  })

  it("reserves imports across two views before either asynchronous journal write completes", async () => {
    const f = fixture()
    try {
      const second: CloudSessionContext = { ...f.ctx, continuations: new Map() }
      await f.preview()
      await handleRequestCloudSessionData(second, "cloud", "second")
      await Promise.all([
        f.send(),
        handleImportAndSend(
          second,
          "cloud",
          "Second",
          "other-message",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          second.continuations.get("cloud")?.id,
        ),
      ])
      expect(f.calls.filter((call) => call.path.endsWith("/import"))).toHaveLength(1)
      expect(f.calls.filter((call) => call.path.includes("prompt_async"))).toHaveLength(1)
    } finally {
      f.close()
    }
  })
  it("releases a reservation if context changes in the microtask before HTTP dispatch", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.state.saving = () =>
        queueMicrotask(() =>
          queueMicrotask(() => {
            f.state.generation++
          }),
        )
      await f.send()
      expect(f.calls).toHaveLength(1)
      expect(await f.ctx.journal.get(JSON.stringify(["cloud", "/repo"]))).toBeUndefined()
      expect(f.ctx.continuations.get("cloud")?.status).toBe("preview")
    } finally {
      f.close()
    }
  })

  it("does not dispatch a prompt if context changes while gathering editor context", async () => {
    const f = fixture()
    try {
      await f.preview()
      f.ctx.gatherEditorContext = async () => {
        f.state.generation++
        return {}
      }
      await f.send()
      expect(f.calls).toHaveLength(2)
      expect(f.sent.at(-1)).toMatchObject({ type: "sendMessageFailed", sessionID: "local", text: "Continue" })
    } finally {
      f.close()
    }
  })
})
