import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { editGoal } from "../../src/kilo-provider/goal"

test("generated goal clear sends a query precondition and exposes conflicts", async () => {
  const calls: Request[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      return calls.length === 1 ? Response.json({}, { status: 409 }) : Response.json(true)
    },
  })
  const result = await client.kilocode.goal.clear({
    sessionID: "session",
    directory: "C:/project with spaces",
    expectedIntent: "reviewed/+&=",
  })
  const url = new URL(calls[0].url)
  expect(calls[0].method).toBe("DELETE")
  expect(url.pathname).toBe("/session/session/goal")
  expect(url.searchParams.get("expectedIntent")).toBe("reviewed/+&=")
  expect(url.searchParams.get("directory")).toBe("C:/project with spaces")
  expect(result.response.status).toBe(409)
  expect(result.error).toBeDefined()
  const cleared = await client.kilocode.goal.clear({ sessionID: "session", expectedIntent: "current" })
  expect(cleared.data).toBe(true)
})

test("pause and resume use conditional edits and require the requested status in the confirmation", async () => {
  const calls: Request[] = []
  const replies: unknown[] = []
  let status = "paused"
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      return Response.json({
        objective: "Goal",
        intent: "saved",
        status,
        createdAt: 1,
        updatedAt: 2,
        usage: { turns: 0, continuations: 0, toolCalls: 0 },
        progress: [],
      })
    },
  })
  const context = {
    client,
    post: (reply: unknown) => replies.push(reply),
    message: {
      type: "goalEdit",
      sessionID: "session",
      requestID: "pause",
      objective: "Goal",
      expectedIntent: "reviewed",
      status: "paused",
    },
  }
  await editGoal(context)
  expect(await calls[0].json()).toEqual({ objective: "Goal", expectedIntent: "reviewed", status: "paused" })
  expect(replies[0]).toMatchObject({ requestID: "pause", goal: { status: "paused" } })
  await editGoal({ ...context, message: { ...context.message, requestID: "resume", status: "active" } })
  expect(replies.at(-1)).toMatchObject({ requestID: "resume", error: expect.any(String) })
  expect(replies.at(-1)).not.toHaveProperty("goal")
  status = "active"
  await editGoal({ ...context, message: { ...context.message, requestID: "resume", status: "active" } })
  expect(replies.at(-1)).toMatchObject({ requestID: "resume", goal: { status: "active" } })
  await editGoal({ ...context, message: { ...context.message, status: "complete" } })
  expect(calls).toHaveLength(3)
  expect(replies.at(-1)).toMatchObject({ error: expect.stringContaining("pause or resume") })
})
