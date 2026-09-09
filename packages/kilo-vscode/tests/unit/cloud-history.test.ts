import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleRequestCloudSessions } from "../../src/kilo-provider/handlers/cloud-session"

test("cloud history reports correlated HTTP failures and forwards pagination without a false empty success", async () => {
  const calls: { path: string; cursor: string | null; repo: string | null }[] = []
  let failing = true
  let payload: unknown = { cliSessions: [], nextCursor: null }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      calls.push({ path: url.pathname, cursor: url.searchParams.get("cursor"), repo: url.searchParams.get("gitUrl") })
      return failing ? Response.json({ error: "private detail" }, { status: 503 }) : Response.json(payload)
    },
  })
  const messages: unknown[] = []
  const client = createKiloClient({ baseUrl: server.url.origin })
  const context = {
    client,
    currentSession: null,
    trackedSessionIds: new Set<string>(),
    connectionService: { recordMessageSessionId() {} },
    postMessage: (message: unknown) => messages.push(message),
    getWorkspaceDirectory: () => "C:/workspace",
    gatherEditorContext: async () => ({}),
  }
  try {
    await handleRequestCloudSessions(context, { requestID: "failed", cursor: "page2", gitUrl: "repo" })
    expect(messages).toEqual([
      { type: "cloudSessionsFailed", requestID: "failed", error: expect.stringContaining("could not be loaded") },
    ])
    expect(JSON.stringify(messages)).not.toContain("private detail")
    expect(calls[0]).toMatchObject({ cursor: "page2", repo: "repo" })
    failing = false
    await handleRequestCloudSessions(context, { requestID: "success" })
    expect(messages.at(-1)).toEqual({
      type: "cloudSessionsLoaded",
      requestID: "success",
      sessions: [],
      nextCursor: null,
    })
    for (const value of [{}, { cliSessions: null }, { cliSessions: [null] }, { cliSessions: [], nextCursor: 4 }]) {
      payload = value
      await handleRequestCloudSessions(context, { requestID: "malformed" })
      expect(messages.at(-1)).toMatchObject({ type: "cloudSessionsFailed", requestID: "malformed" })
    }
    await handleRequestCloudSessions({ ...context, client: null }, { requestID: "disconnected" })
    expect(messages.at(-1)).toMatchObject({ type: "cloudSessionsFailed", requestID: "disconnected" })
  } finally {
    await server.stop(true)
  }
  await handleRequestCloudSessions(context, { requestID: "lost" })
  expect(messages.at(-1)).toMatchObject({ type: "cloudSessionsFailed", requestID: "lost" })
  expect(calls).toHaveLength(6)
})
