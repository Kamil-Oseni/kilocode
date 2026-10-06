import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { KiloProviderMemory } from "../../src/kilo-provider/memory"

for (const stage of ["queued", "toggle", "load"] as const) {
  for (const scope of ["directory", "client", "generation", "session", "current"] as const) {
    test(`${stage} memory preserves ${scope} ownership`, async () => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const calls: Array<{ route: string; directory: string | null }> = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          calls.push({ route: url.pathname, directory: url.searchParams.get("directory") })
          if (calls.length === 1) {
            entered.resolve()
            await release.promise
          }
          return Response.json({ state: { enabled: true }, index: {}, root: "test" })
        },
      })
      const original = createKiloClient({ baseUrl: server.url.href })
      const posts: unknown[] = []
      const state = { client: original, directory: "C:/original", generation: 1, session: { id: "original" } }
      const memory = new KiloProviderMemory({
        client: () => state.client,
        generation: () => state.generation,
        session: () => state.session,
        dir: () => state.directory,
        post: (message) => posts.push(message),
      })
      const first = stage === "toggle" ? memory.toggle() : memory.fetch()
      await entered.promise
      const queued = stage === "queued" ? memory.run({ operation: "disable" }) : undefined
      if (scope === "directory") state.directory = "C:/replacement"
      if (scope === "client") state.client = createKiloClient({ baseUrl: server.url.href })
      if (scope === "generation") state.generation++
      if (scope === "session") state.session = { id: "replacement" }
      release.resolve()
      try {
        await first
        await queued
        const mutations = calls.filter((call) => call.route === "/memory/disable")
        expect(mutations).toEqual(
          stage !== "load" && scope === "current" ? [{ route: "/memory/disable", directory: "C:/original" }] : [],
        )
        if (stage === "load" && scope !== "current") expect(posts).toEqual([])
        if (stage === "queued" && scope !== "current")
          expect(posts).toEqual([
            expect.objectContaining({
              type: "memoryOperationResult",
              operation: "disable",
              ok: false,
              error: expect.stringContaining("changed"),
            }),
          ])
      } finally {
        release.resolve()
        await memory.idle()
        server.stop(true)
      }
    }, 10000)
  }
}
