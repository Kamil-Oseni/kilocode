import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { editGoal } from "../../src/kilo-provider/goal"
import type { GoalEditMessage } from "../../webview-ui/src/types/messages/webview-messages"

test("goal edits send the reviewed revision and correlate success, conflict, invalid and uncertain replies", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  let mode = "success"
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      if (mode === "connection") throw new Error("Connection lost")
      if (mode === "conflict") return Response.json({}, { status: 409 })
      return Response.json({
        objective: mode === "mismatch" ? "Wrong goal" : "Revised goal",
        intent: "saved",
        status: "paused",
        createdAt: mode === "invalid" ? "NaN" : 1,
        updatedAt: 2,
        usage: { turns: 0, continuations: 0, toolCalls: 0 },
        progress: [],
      })
    },
  })
  const message: GoalEditMessage = {
    type: "goalEdit",
    sessionID: "session",
    requestID: "request",
    objective: " Revised goal ",
    expectedIntent: "reviewed",
  }
  const context = { client, directory: "workspace", message, post: (reply: unknown) => messages.push(reply) }
  await editGoal(context)
  expect(calls).toHaveLength(1)
  expect(calls[0].method).toBe("PATCH")
  expect(new URL(calls[0].url).pathname).toBe("/session/session/goal")
  expect(new URL(calls[0].url).searchParams.get("directory")).toBe("workspace")
  expect(await calls[0].json()).toEqual({ objective: "Revised goal", expectedIntent: "reviewed" })
  expect(messages[0]).toMatchObject({
    type: "goalEdited",
    requestID: "request",
    sessionID: "session",
    goal: { intent: "saved", objective: "Revised goal" },
  })
  await editGoal({ ...context, message: { ...message, expectedIntent: undefined } as unknown as GoalEditMessage })
  expect(calls).toHaveLength(1)
  expect(messages.at(-1)).toMatchObject({ type: "goalEdited", requestID: "request", error: expect.any(String) })
  await editGoal({ ...context, client: null })
  expect(calls).toHaveLength(1)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("disconnected") })
  for (const failure of ["conflict", "mismatch", "connection", "invalid"]) {
    mode = failure
    await editGoal(context)
    expect(messages.at(-1)).toMatchObject({
      type: "goalEdited",
      requestID: "request",
      sessionID: "session",
      error: expect.any(String),
    })
    expect(messages.at(-1)).not.toHaveProperty("goal")
  }
})

test("goal criteria edits validate drafts and require matching saved criteria", async () => {
  const criteria = [{ id: "result", description: "Working result", verification: "Run checks", required: false }]
  const sent: Request[] = []
  const messages: unknown[] = []
  let returned: typeof criteria | undefined = criteria
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      sent.push(new Request(input, init))
      return Response.json({
        objective: "Goal",
        status: "paused",
        intent: "saved",
        createdAt: 1,
        updatedAt: 2,
        usage: { turns: 0, toolCalls: 0, continuations: 0 },
        progress: [],
        criteria: returned,
      })
    },
  })
  const message: GoalEditMessage = {
    type: "goalEdit",
    sessionID: "session",
    requestID: "criteria",
    objective: "Goal",
    expectedIntent: "original",
    criteria,
  }
  const context = { client, message, post: (value: unknown) => messages.push(value) }
  await editGoal(context)
  expect(await sent[0].json()).toMatchObject({ criteria, expectedIntent: "original" })
  expect(messages.at(-1)).toMatchObject({ goal: { criteria } })
  returned = undefined
  await editGoal(context)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("did not match") })
  await editGoal({ ...context, message: { ...message, criteria: [] } })
  expect(sent).toHaveLength(2)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("criteria") })
})

test("review acceptance sends current intent and requires an accepted completion", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  let accepted = true
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      return Response.json({
        objective: "Goal",
        intent: "saved",
        status: accepted ? "complete" : "paused",
        review: {
          status: accepted ? "accepted" : "pending",
          at: 1,
          criteria: ["result"],
          acceptedAt: accepted ? 2 : undefined,
        },
        createdAt: 1,
        updatedAt: 2,
        usage: { turns: 0, continuations: 0, toolCalls: 0 },
        progress: [],
      })
    },
  })
  const message = {
    type: "goalEdit",
    sessionID: "session",
    requestID: "accept",
    objective: "Goal",
    expectedIntent: "reviewed",
    accept: true as const,
  }
  const context = { client, message, post: (value: unknown) => messages.push(value) }
  await editGoal(context)
  expect(await calls[0].json()).toMatchObject({ accept: true, expectedIntent: "reviewed" })
  expect(messages.at(-1)).toMatchObject({ goal: { status: "complete", review: { status: "accepted" } } })
  accepted = false
  await editGoal(context)
  expect(messages.at(-1)).toHaveProperty("error")
  for (const accept of [false, "true"]) await editGoal({ ...context, message: { ...message, accept } })
  expect(calls).toHaveLength(2)
})
