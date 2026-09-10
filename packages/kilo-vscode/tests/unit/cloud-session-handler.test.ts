import { describe, expect, it } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import {
  handleImportAndSend,
  handleRequestCloudSessionData,
  type CloudSessionContext,
} from "../../src/kilo-provider/handlers/cloud-session"

function fixture() {
  const calls: { path: string; directory: string | null; body: unknown }[] = []
  const sent: Record<string, unknown>[] = []
  const journal = new Map<string, { sessionID?: string }>()
  const state = { directory: "/repo", generation: 0, fail: false, sending: false, imported: () => {}, saving: () => {} }
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
        return state.fail
          ? Response.json({ error: "lost acknowledgement" }, { status: 503 })
          : Response.json({ id: "local", title: "Copy", time: { created: 1, updated: 1 } })
      }
      if (path.includes("/session/local/")) return new Response(null, { status: state.sending ? 503 : 204 })
      return Response.json({ info: { title: "Cloud original" }, messages: [] })
    },
  })
  const ctx: CloudSessionContext = {
    client: createKiloClient({ baseUrl: server.url.origin }),
    get generation() {
      return state.generation
    },
    continuations: new Map(),
    claims: new Set(),
    currentSession: null,
    trackedSessionIds: new Set(),
    journal: {
      get: (key) => journal.get(key),
      update: async (key, record) => {
        state.saving()
        if (record) journal.set(key, record)
        else journal.delete(key)
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
        { path: "/kilo/cloud/session/import", directory: "/repo", body: { sessionId: "cloud" } },
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
      expect(f.ctx.claims.size).toBe(0)
      expect(f.ctx.journal.get(JSON.stringify(["cloud", "/repo"]))).toBeUndefined()
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
