import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { sameDirectory } from "../../src/kilo-provider-utils"

const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
const start = source.indexOf("  private refreshSessionDetails(")
const end = source.indexOf("  private fetchAndSendSessionModelUsage(", start)
if (start < 0 || end < start) throw new Error("Production session detail refresh missing")
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `(class Subject { ${source.slice(start, end).replace("private refreshSessionDetails", "refreshSessionDetails")} })`,
)
const Subject = new Function("sameDirectory", `return ${code}`)(sameDirectory) as {
  new (): { refreshSessionDetails(id: string, dir: string): void }
}

for (const scope of ["client", "generation", "directory", "disconnected", "current"] as const) {
  test(`session details and statuses refuse stale ${scope} replies`, async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const effects: unknown[] = []
    let requests = 0
    let completed = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (++requests === 2) entered.resolve()
        await release.promise
        return Response.json(
          new URL(request.url).pathname.endsWith("/status") ? { session: { type: "busy" } } : { id: "session" },
        )
      },
    })
    const client = createKiloClient({
      baseUrl: server.url.href,
      async fetch(request) {
        const response = await fetch(request)
        // Observe actual body consumption by the generated SDK before checking publications.
        const text = response.text.bind(response)
        response.text = async () => {
          const value = await text()
          if (++completed === 2) finished.resolve()
          return value
        }
        return response
      },
    })
    const state = Object.assign(new Subject(), {
      client,
      connectionGeneration: 1,
      connectionState: "connected",
      directory: "C:/original",
      contextSessionID: "session",
      sessionGitDirectories: new Map<string, string>(),
      revisions: new Map<string, number>(),
      refreshes: new Map<string, number>(),
      trackedSessionIds: new Set(["session"]),
      getWorkspaceDirectory: () => state.directory,
      refreshGitStatus: () => Promise.resolve(),
      setCurrentSession: (value: unknown) => effects.push(value),
      sessionToWebview: (value: unknown) => value,
      postMessage: (value: unknown) => effects.push(value),
    })
    try {
      state.refreshSessionDetails("session", state.directory)
      await entered.promise
      effects.length = 0
      if (scope === "client") state.client = createKiloClient({ baseUrl: server.url.href })
      if (scope === "generation") state.connectionGeneration++
      if (scope === "directory") state.directory = "C:/replacement"
      if (scope === "disconnected") state.connectionState = "disconnected"
      release.resolve()
      await finished.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(requests).toBe(2)
      expect(effects.length).toBe(scope === "current" ? 3 : 0)
    } finally {
      release.resolve()
      server.stop(true)
    }
  }, 10000)
}
