import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { stopResult } from "../../src/kilo-provider/goal"
import { sameDirectory } from "../../src/kilo-provider-utils"

const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
const start = source.indexOf("  private async fetchAndSendGoal(")
const end = source.indexOf("  private async handleGoalControl(", start)
if (start < 0 || end < 0) throw new Error("Production goal fetch method not found")
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `(class Subject { ${source.slice(start, end).replace("private async", "async")} })`,
)
const create = (stop: typeof stopResult) =>
  new Function("stopResult", "sameDirectory", `return ${code}`)(stop, sameDirectory) as {
    new (): { fetchAndSendGoal(sessionID: string): Promise<void> }
  }
const Subject = create(async () => "Saved stop result")

test("goal fetch distinguishes a missing response, backend error, and missing goal", async () => {
  const messages: Record<string, unknown>[] = []
  const state = Object.assign(new Subject(), {
    client: {
      kilocode: {
        goal: {
          get: async (): Promise<unknown> => ({ response: null, data: undefined, error: new Error("offline") }),
        },
      },
    },
    getWorkspaceDirectory: () => "C:/project",
    postMessage: (message: Record<string, unknown>) => messages.push(message),
  })

  await expect(state.fetchAndSendGoal("session")).resolves.toBeUndefined()
  expect(messages).toEqual([
    {
      type: "goalState",
      sessionID: "session",
      notice: expect.stringContaining("could not read the current goal"),
    },
  ])

  state.client.kilocode.goal.get = async () => {
    throw new Error("backend disconnected")
  }
  await expect(state.fetchAndSendGoal("session")).resolves.toBeUndefined()
  expect(messages).toHaveLength(2)

  state.client.kilocode.goal.get = async () => ({ response: { status: 503 }, error: { message: "Unavailable" } })
  await expect(state.fetchAndSendGoal("session")).resolves.toBeUndefined()
  expect(messages).toHaveLength(3)

  state.client.kilocode.goal.get = async () => ({ response: { status: 404 }, data: undefined })
  await expect(state.fetchAndSendGoal("session")).resolves.toBeUndefined()
  expect(messages.slice(3)).toEqual([
    { type: "goalState", sessionID: "session", goal: undefined, notice: undefined },
    { type: "goalStopResult", sessionID: "session", notice: "Saved stop result" },
  ])
})

for (const kind of ["client", "generation", "directory", "stop"] as const) {
  test(`actual SDK goal read rejects stale ${kind} scope and permits a fresh read`, async () => {
    const held = Promise.withResolvers<Response>()
    const entered = Promise.withResolvers<void>()
    const requests: string[] = []
    const messages: Record<string, unknown>[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push(url.pathname)
        if (kind === "stop" && !url.pathname.endsWith("/stop"))
          return Response.json({ error: "Missing goal" }, { status: 404 })
        entered.resolve()
        return held.promise.then((response) => response.clone())
      },
    })
    const Subject = create(stopResult)
    const state = Object.assign(new Subject(), {
      client: createKiloClient({ baseUrl: server.url.toString() }),
      connectionGeneration: 1,
      directory: "C:/original",
      getWorkspaceDirectory: () => state.directory,
      postMessage: (message: Record<string, unknown>) => messages.push(message),
    })
    const pending = state.fetchAndSendGoal("session")
    try {
      await entered.promise
      if (kind === "client") state.client = createKiloClient({ baseUrl: server.url.toString() })
      if (kind === "generation" || kind === "stop") state.connectionGeneration++
      if (kind === "directory") state.directory = "C:/replacement"
      const count = messages.length
      held.resolve(
        Response.json(
          kind === "stop"
            ? { sessionID: "session", intent: "original", at: 1, phase: "cleared" }
            : { objective: "Original scope", status: "active" },
        ),
      )
      await pending
      expect(messages).toHaveLength(count)
      expect(messages.some((message) => message.type === "goalStopResult")).toBe(false)
      expect(requests).toHaveLength(kind === "stop" ? 2 : 1)
      await state.fetchAndSendGoal("session")
      expect(messages.length).toBeGreaterThan(count)
      expect(messages.at(-1)?.type).toBe(kind === "stop" ? "goalStopResult" : "goalState")
    } finally {
      held.resolve(Response.json({}, { status: 503 }))
      await pending
      await server.stop(true)
    }
  })
}
