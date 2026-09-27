import { expect, test } from "bun:test"

const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
const start = source.indexOf("  private async fetchAndSendGoal(")
const end = source.indexOf("  private async handleGoalControl(", start)
if (start < 0 || end < 0) throw new Error("Production goal fetch method not found")
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `(class Subject { ${source.slice(start, end).replace("private async", "async")} })`,
)
const Subject = new Function("stopResult", `return ${code}`)(async () => "Saved stop result") as {
  new (): { fetchAndSendGoal(sessionID: string): Promise<void> }
}

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
