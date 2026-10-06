import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { sameDirectory } from "../../src/kilo-provider-utils"
import { StaleReview } from "../../src/edit-review/unsaved"

const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
const start = source.indexOf("  private async handleDiscardSessionChanges(")
const end = source.indexOf("  /**\n   * Handle compact", start)
if (start < 0 || end < start) throw new Error("Production edit recovery methods missing")
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `(class Subject { ${source.slice(start, end).replaceAll("private async", "async")} })`,
)
type Method = "handleDiscardSessionChanges" | "handleKeepSessionChanges" | "handleUnrevertSession"
const Subject = new Function("sameDirectory", "sessionToWebview", "StaleReview", `return ${code}`)(
  sameDirectory,
  (value: unknown) => value,
  StaleReview,
) as {
  new (): Record<Method, (sessionID: string) => Promise<void>>
}

for (const method of ["handleDiscardSessionChanges", "handleKeepSessionChanges", "handleUnrevertSession"] as const) {
  for (const status of [200, 503]) {
    for (const scope of ["client", "generation", "directory", "disconnected", "current"] as const) {
      test(`${method} checks ${status} completion ownership for ${scope} scope`, async () => {
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<Response>()
        const effects: unknown[] = []
        const requests: string[] = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            requests.push(request.url)
            entered.resolve()
            return release.promise
          },
        })
        const client = createKiloClient({ baseUrl: server.url.href })
        const state = Object.assign(new Subject(), {
          client,
          connectionGeneration: 1,
          connectionState: "connected",
          directory: "C:/original",
          currentSession: { id: "session" },
          refreshes: new Map<string, number>(),
          lastReviewHash: "original",
          getWorkspaceDirectory: () => state.directory,
          setCurrentSession: (value: unknown) => effects.push(value),
          postMessage: (value: unknown) => effects.push(value),
          scheduleReview: (value: unknown) => effects.push(value),
          inEditorReview: { refresh: () => effects.push("editor") },
        })
        const pending = state[method]("session").then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        )
        try {
          await entered.promise
          if (scope === "client") state.client = createKiloClient({ baseUrl: server.url.href })
          if (scope === "generation") state.connectionGeneration++
          if (scope === "directory") state.directory = "C:/replacement"
          if (scope === "disconnected") state.connectionState = "disconnected"
          release.resolve(
            Response.json(status === 200 ? { id: "session" } : { message: "fixture failure" }, { status }),
          )
          const result = await pending
          expect(requests).toHaveLength(1)
          expect(new URL(requests[0]).searchParams.get("directory")).toBe("C:/original")
          const stale = scope !== "current" && method !== "handleUnrevertSession"
          expect(result.error !== undefined).toBe(status === 503 || stale)
          if (status === 200 && stale) expect(result.error).toBeInstanceOf(StaleReview)
          if (scope !== "current") {
            expect(effects).toHaveLength(0)
            expect(state.refreshes.size).toBe(0)
            expect(state.lastReviewHash).toBe("original")
          }
          if (scope === "current" && status === 200) expect(effects.length).toBeGreaterThan(0)
          if (status === 503) {
            expect(state.refreshes.size).toBe(0)
            expect(state.lastReviewHash).toBe("original")
          }
        } finally {
          release.resolve(Response.json({ id: "session" }))
          await pending
          server.stop(true)
        }
      }, 10000)
    }
  }
}
