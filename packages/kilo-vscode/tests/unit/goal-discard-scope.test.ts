import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { sameDirectory } from "../../src/kilo-provider-utils"

const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
const start = source.indexOf('    if (message.type === "goalDiscard") {')
const end = source.indexOf('    if (message.type !== "goalControl")', start)
const rewind = source.indexOf("  private async handleRevertSession(")
const finish = source.indexOf("  // raya_change - discards", rewind)
if ([start, end, rewind, finish].some((value) => value < 0)) throw new Error("Production Goal recovery bodies missing")
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `(class Subject { async dispatch(message) { ${source.slice(start, end)} }; ${source.slice(rewind, finish).replace("private async", "async")} })`,
)
const Subject = new Function("sameDirectory", "sessionToWebview", `return ${code}`)(
  sameDirectory,
  (value: unknown) => value,
) as {
  new (): { dispatch(message: { type: string; sessionID: string; messageID: string }): Promise<boolean> }
}

for (const phase of ["queued", "rewind", "discard"] as const) {
  for (const scope of ["client", "generation", "directory", "disconnected", "current"] as const) {
    test(`Goal recovery fences ${scope} replacement during ${phase}`, async () => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<Response>()
      const queue = Promise.withResolvers<void>()
      const paths: string[] = []
      const posts: unknown[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname
          paths.push(path)
          if (phase !== "queued" && path.endsWith(phase === "rewind" ? "/revert" : "/discard")) {
            entered.resolve()
            return release.promise
          }
          return Response.json({ id: "session" })
        },
      })
      const client = createKiloClient({ baseUrl: server.url.href })
      const state = Object.assign(new Subject(), {
        client,
        connectionGeneration: 1,
        connectionState: "connected",
        directory: "C:/original",
        currentSession: undefined,
        refreshes: new Map<string, number>(),
        getWorkspaceDirectory: () => state.directory,
        setCurrentSession: () => {},
        postMessage: (message: unknown) => posts.push(message),
        fetchAndSendGoal: async () => {
          posts.push("refresh")
        },
        pending: Promise.resolve(),
        checkpoint: (_sid: string, run: () => Promise<void>) => {
          state.pending = phase === "queued" ? queue.promise.then(run) : run()
          if (phase === "queued") entered.resolve()
        },
      })
      try {
        await state.dispatch({ type: "goalDiscard", sessionID: "session", messageID: "message" })
        await entered.promise
        const count = posts.length
        if (scope === "client") state.client = createKiloClient({ baseUrl: server.url.href })
        if (scope === "generation") state.connectionGeneration++
        if (scope === "directory") state.directory = "C:/replacement"
        if (scope === "disconnected") state.connectionState = "disconnected"
        queue.resolve()
        release.resolve(Response.json({ id: "session" }))
        await state.pending
        expect(paths).toHaveLength(scope === "current" ? 2 : phase === "queued" ? 0 : phase === "rewind" ? 1 : 2)
        expect(posts).toHaveLength(scope === "current" ? 2 : count)
      } finally {
        queue.resolve()
        release.resolve(Response.json({ id: "session" }))
        await state.pending
        server.stop(true)
      }
    }, 10000)
  }
}
