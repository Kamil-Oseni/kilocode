import { expect, it } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { loadSessions, type SessionRefreshContext } from "../../src/kilo-provider-utils"

const { KiloProvider } = await import("../../src/KiloProvider")

type Provider = {
  connectionState: string
  openSessionIds: Set<string>
  getSessionRefreshContext: (revision: number) => SessionRefreshContext
}

for (const status of [200, 404, 500])
  it(`uses the actual SDK HTTP ${status} response to qualify an omitted open Routine`, async () => {
    const calls: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        calls.push(url.pathname)
        expect(url.searchParams.get("directory")).toBe("/original")
        if (url.pathname === "/session") return Response.json([])
        expect(url.pathname).toBe("/session/routine")
        return Response.json(
          status === 200
            ? {
                id: "routine",
                slug: "original",
                projectID: "project",
                directory: "/original",
                title: "Original Routine",
                version: "fixture",
                time: { created: 1, updated: 2 },
                metadata: { rayaRoutine: { version: 2, agentID: "worker", runID: "run" } },
              }
            : { name: "LookupError", data: { message: "Lookup unavailable" } },
          { status },
        )
      },
    })
    try {
      const client = createKiloClient({ baseUrl: server.url.origin })
      const provider = new KiloProvider({} as never, { getClient: () => client } as never, undefined, {
        rootDirectory: () => "/original",
      })
      const owner = provider as unknown as Provider
      owner.connectionState = "connected"
      owner.openSessionIds.add("routine")
      const ctx = owner.getSessionRefreshContext(0)
      const sent: unknown[] = []
      ctx.postMessage = (message) => sent.push(message)
      if (status === 500) await expect(loadSessions(ctx)).rejects.toBeDefined()
      if (status !== 500) await loadSessions(ctx)
      expect(calls).toEqual(["/session", "/session/routine"])
      expect(sent).toEqual(
        status === 500
          ? []
          : [{ type: "sessionsLoaded", sessions: [], ...(status === 200 ? { preserveSessionIds: ["routine"] } : {}) }],
      )
      expect(ctx.pendingSessionRefresh).toBe(status === 500)
    } finally {
      await server.stop(true)
    }
  })
