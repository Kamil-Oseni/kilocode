import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { editGoal, stopGoal } from "../../src/kilo-provider/goal"
import { sameDirectory } from "../../src/kilo-provider-utils"

// Exercise the production method and actual host helper without loading VS Code.
// This is the same extraction boundary used by goal-fetch.test.ts.
const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
const start = source.indexOf("  private async handleGoalMessage(")
const end = source.indexOf("  private async handleRoutineMessage(", start)
if (start < 0 || end < 0) throw new Error("Production Goal control method not found")
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `(class Subject { ${source.slice(start, end).replace("private async", "async")} })`,
)
const Subject = new Function("stopGoal", "editGoal", "sameDirectory", `return ${code}`)(
  stopGoal,
  editGoal,
  sameDirectory,
) as {
  new (): { handleGoalMessage(message: Record<string, unknown>): Promise<boolean> }
}
const receipt = {
  sessionID: "ses_original",
  intent: "original-intent",
  phase: "cleared",
  at: 1,
  interrupted: false,
  task: {
    version: 1,
    sessionDigest: "a".repeat(64),
    stop: { version: 1, intent: "original-intent", at: 1 },
    runs: [{ id: "original-run", agentID: "original-agent", sessionID: "ses_original", at: 1, scheduleVersion: 1 }],
  },
}

for (const stage of ["receipt", "mutation"] as const)
  for (const kind of ["client", "generation", "directory", "session"] as const)
    test(`production Goal handler fences ${kind} changes while Stop ${stage} is held`, async () => {
      const entered = Promise.withResolvers<void>()
      const held = Promise.withResolvers<Response>()
      const requests: Request[] = []
      const replies: unknown[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(request.clone())
          if (new URL(request.url).pathname.endsWith("/goal"))
            return Response.json({ error: "No current Goal" }, { status: 404 })
          if (stage === "receipt" || request.method === "POST") {
            entered.resolve()
            return held.promise.then((response) => response.clone())
          }
          return Response.json(receipt)
        },
      })
      const client = createKiloClient({ baseUrl: server.url.toString() })
      const state = Object.assign(new Subject(), {
        client,
        connectionGeneration: 1,
        currentSession: { id: receipt.sessionID },
        directory: "C:/original",
        getWorkspaceDirectory: (sessionID?: string): string => {
          expect(sessionID).toBe(receipt.sessionID)
          return state.directory
        },
        postMessage: (reply: unknown) => replies.push(reply),
      })
      const pending = state.handleGoalMessage({
        type: "goalStop",
        sessionID: receipt.sessionID,
        requestID: "original-request",
        expectedIntent: receipt.intent,
        retry: true,
      })
      try {
        await entered.promise
        if (kind === "client") state.client = createKiloClient({ baseUrl: server.url.toString() })
        if (kind === "generation") state.connectionGeneration++
        if (kind === "directory") state.directory = "C:/replacement"
        if (kind === "session") state.currentSession = { id: "ses_other" }
        held.resolve(Response.json(stage === "receipt" ? receipt : { ...receipt, phase: "finished", finishedAt: 2 }))
        expect(await pending).toBe(true)
        expect(requests.filter((request) => request.method === "POST")).toHaveLength(stage === "receipt" ? 0 : 1)
        expect(requests.every((request) => new URL(request.url).searchParams.get("directory") === "C:/original")).toBe(
          true,
        )
        expect(replies).toEqual([])
      } finally {
        held.resolve(Response.json({}, { status: 503 }))
        await pending
        await server.stop(true)
      }
    })
