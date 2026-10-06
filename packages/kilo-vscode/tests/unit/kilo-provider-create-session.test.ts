import { describe, expect, it } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { KiloProvider } from "../../src/KiloProvider"

// Exercise the real provider dispatcher and generated SDK against a local HTTP
// fixture. Only the VS Code transport/presence boundary is supplied by the test.
describe("explicit session creation correlation", () => {
  it("echoes only the requesting draft on success, failure, and disconnected replies", async () => {
    const requests: { path: string; body: unknown }[] = []
    const arrival = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const session = {
      id: "ses_fixture_created",
      slug: "fixture",
      projectID: "fixture",
      directory: "C:/fixture",
      title: "New session",
      version: "fixture",
      time: { created: 1, updated: 1 },
    }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        requests.push({ path, body: await request.json() })
        if (requests.length === 2) return Response.json({ message: "Creation rejected" }, { status: 500 })
        arrival.resolve()
        await release.promise
        return Response.json(session)
      },
    })
    const client = createKiloClient({ baseUrl: server.url.toString() })
    const state = { connected: true }
    const connection = {
      getClient: () => (state.connected ? client : null),
      sandboxPreference: { explicit: () => false, wait: async () => {}, onChange: () => () => {} },
      unregisterVisible: () => {},
      unregisterAttached: () => {},
    }
    const provider = new KiloProvider({} as never, connection as never, undefined, {
      projectDirectory: "C:/fixture",
      disableViewedRegistration: true,
    })
    const sent: unknown[] = []
    const internal = provider as unknown as {
      webview: { postMessage: (message: unknown) => Promise<boolean> }
      handleSessionControl: (message: { type: string; draftID?: unknown }) => Promise<boolean>
      currentSession: { id: string } | null
      contextSessionID: string | undefined
      streams: { focused: string | undefined }
      connectionState: "connected" | "disconnected"
      handleEvent: (event: unknown) => void
    }
    internal.webview = { postMessage: async (message) => (sent.push(message), true) }
    internal.connectionState = "connected"
    try {
      for (const draftID of [{ id: "untrusted" }, "x".repeat(1000), ""]) {
        await internal.handleSessionControl({ type: "createSession", draftID })
        expect(sent.at(-1)).toEqual({ type: "error", message: "Invalid session creation request" })
      }
      expect(requests).toHaveLength(0)
      const pending = internal.handleSessionControl({
        type: "createSession",
        draftID: "17f663f4-54db-4d38-b1b0-2f4f5bf8a443",
      })
      await arrival.promise
      internal.handleEvent({ type: "session.created", properties: { info: { ...session, id: "ses_unrelated_sse" } } })
      expect(internal.currentSession).toBeNull()
      expect(internal.contextSessionID).toBeUndefined()
      expect(sent.at(-1)).toMatchObject({ type: "sessionCreated", session: { id: "ses_unrelated_sse" } })
      expect(sent.at(-1)).not.toHaveProperty("draftID")
      internal.currentSession = { id: "ses_user_navigated" }
      internal.contextSessionID = "ses_user_navigated"
      internal.handleEvent({ type: "session.created", properties: { info: session } })
      expect(internal.currentSession).toEqual({ id: "ses_user_navigated" })
      release.resolve()
      expect(await pending).toBe(true)
      expect(internal.currentSession).toEqual({ id: "ses_user_navigated" })
      expect(internal.contextSessionID).toBe("ses_user_navigated")
      expect(internal.streams.focused).toBeUndefined()
      expect(requests).toEqual([
        { path: "/session", body: { metadata: { "kilocode.sandbox": { enabled: false, version: 0 } } } },
      ])
      expect(sent.at(-1)).toMatchObject({
        type: "sessionCreated",
        draftID: "17f663f4-54db-4d38-b1b0-2f4f5bf8a443",
        session: { id: "ses_fixture_created" },
      })
      await internal.handleSessionControl({ type: "createSession", draftID: "0e261fed-063b-4e67-946b-239bef178dcf" })
      expect(sent.at(-1)).toMatchObject({
        type: "sendMessageFailed",
        draftID: "0e261fed-063b-4e67-946b-239bef178dcf",
        text: "",
      })
      state.connected = false
      internal.connectionState = "disconnected"
      await internal.handleSessionControl({ type: "createSession", draftID: "cfe3f2d8-8844-4db1-84c3-1c5e6df06ba7" })
      expect(sent.at(-1)).toEqual({
        type: "sendMessageFailed",
        draftID: "cfe3f2d8-8844-4db1-84c3-1c5e6df06ba7",
        error: "Not connected to CLI backend",
        text: "",
      })
      await internal.handleSessionControl({ type: "createSession" })
      expect(sent.at(-1)).toEqual({ type: "error", message: "Not connected to CLI backend" })
      expect(requests).toHaveLength(2)
    } finally {
      provider.dispose()
      server.stop(true)
    }
  })
})
