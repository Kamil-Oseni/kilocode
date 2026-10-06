import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { sameDirectory } from "../../src/kilo-provider-utils"
import { sandboxSessionMetadata } from "../../src/shared/sandbox-session"

const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
const start = source.indexOf("  private async handleCreateSession(")
const end = source.indexOf("  /** Non-blocking:", start)
if (start < 0 || end < start) throw new Error("Production session creation missing")
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `(class Subject { ${source.slice(start, end).replace("private async", "async")} })`,
)
const Subject = new Function("sameDirectory", "sandboxSessionMetadata", "getErrorMessage", `return ${code}`)(
  sameDirectory,
  sandboxSessionMetadata,
  (error: unknown) => String(error),
) as { new (): { handleCreateSession(draft?: string): Promise<void> } }

for (const stage of ["config", "session"] as const) {
  for (const scope of ["client", "generation", "directory", "project", "disconnected", "current"] as const) {
    for (const draft of [undefined, "draft"] as const) {
      test(`session creation fences ${stage} ${scope} ${draft ?? "direct"}`, async () => {
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const effects: Array<{ type?: string }> = []
        const requests: string[] = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const route = new URL(request.url).pathname.split("/").at(-1)!
            requests.push(route)
            if (route === stage) {
              entered.resolve()
              await release.promise
            }
            return Response.json(route === "config" ? { sandbox: { enabled: true } } : { id: "session" })
          },
        })
        const client = createKiloClient({ baseUrl: server.url.href })
        const state = Object.assign(new Subject(), {
          client,
          connectionGeneration: 1,
          connectionState: "connected",
          directory: "C:/original",
          project: "original",
          opts: { projectQualifier: () => ({ projectId: state.project }) },
          connectionService: {},
          trackedSessionIds: new Set<string>(),
          getContextDirectory: () => state.directory,
          stopCurrentSessionProcesses: () => effects.push({ type: "stop" }),
          setCurrentSession: () => effects.push({ type: "set" }),
          focusSession: () => effects.push({ type: "focus" }),
          trackDirectory: () => effects.push({ type: "track" }),
          sessionToWebview: (value: unknown) => value,
          postMessage: (value: { type?: string }) => effects.push(value),
        })
        const pending = state.handleCreateSession(draft)
        try {
          await entered.promise
          if (scope === "client") state.client = createKiloClient({ baseUrl: server.url.href })
          if (scope === "generation") state.connectionGeneration++
          if (scope === "directory") state.directory = "C:/replacement"
          if (scope === "project") state.project = "replacement"
          if (scope === "disconnected") state.connectionState = "disconnected"
          release.resolve()
          await pending
          expect(requests).toHaveLength(stage === "config" && scope !== "current" ? 1 : 2)
          expect(effects.some((item) => item.type === "sessionCreated")).toBe(scope === "current")
          expect(state.trackedSessionIds.has("session")).toBe(scope === "current")
          if (scope !== "current") {
            expect(effects).toEqual(
              draft
                ? [
                    {
                      type: "sendMessageFailed",
                      error: expect.stringContaining("connection changed"),
                      text: "",
                      draftID: draft,
                    },
                  ]
                : [],
            )
          }
        } finally {
          release.resolve()
          await pending
          server.stop(true)
        }
      }, 10000)
    }
  }
}
