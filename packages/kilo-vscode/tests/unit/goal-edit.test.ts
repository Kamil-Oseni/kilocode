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
  const criteria = [
    {
      id: "result",
      description: "Working result",
      verification: "Run checks",
      required: false,
      check: { kind: "command" as const, command: "bun test", directory: "C:/workspace" },
    },
  ]
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
  const context = { client, authorize: async () => () => true, message, post: (value: unknown) => messages.push(value) }
  await editGoal(context)
  expect(await sent[0].json()).toMatchObject({ criteria, expectedIntent: "original" })
  expect(messages.at(-1)).toMatchObject({ goal: { criteria } })
  returned = [{ ...criteria[0], check: { ...criteria[0].check, command: "echo passed" } }]
  await editGoal(context)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("did not match") })
  returned = undefined
  await editGoal(context)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("did not match") })
  await editGoal({ ...context, message: { ...message, criteria: [] } })
  expect(sent).toHaveLength(3)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("criteria") })
  await editGoal({
    ...context,
    message: { ...message, criteria: [{ ...criteria[0], check: { ...criteria[0].check, directory: "relative" } }] },
  })
  expect(sent).toHaveLength(3)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("criteria") })
})

test("goal limit edits validate and require an exact saved acknowledgement", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  const saved = {
    activeMs: 60_000,
    modelCost: 4,
    recoveryAttempts: 2,
    concurrentChildren: 3,
    chargeCosts: [{ currency: "USD", limit: 2, reservation: 0.5 }],
  }
  let returned: typeof saved | undefined = saved
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      return Response.json({
        objective: "Goal",
        intent: "saved",
        status: "paused",
        createdAt: 1,
        updatedAt: 2,
        usage: { turns: 0, toolCalls: 0, continuations: 0 },
        progress: [],
        budget: returned,
      })
    },
  })
  const message: GoalEditMessage = {
    type: "goalEdit",
    sessionID: "session",
    requestID: "limits",
    objective: "Goal",
    expectedIntent: "reviewed",
    budget: saved,
    budgetReason: "Raise the reviewed ceiling for the next phase.",
  }
  const context = { client, message, post: (value: unknown) => messages.push(value) }
  await editGoal(context)
  expect(await calls[0].json()).toMatchObject({
    budget: saved,
    budgetReason: "Raise the reviewed ceiling for the next phase.",
    expectedIntent: "reviewed",
  })
  expect(messages.at(-1)).toMatchObject({ goal: { budget: saved } })
  returned = { ...saved, modelCost: 5 }
  await editGoal(context)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("did not match") })
  returned = undefined
  await editGoal({
    ...context,
    message: { ...message, budget: null, budgetReason: "Remove limits after reviewing the completed phase." },
  })
  expect(await calls[2].json()).toMatchObject({
    clearBudget: true,
    budgetReason: "Remove limits after reviewing the completed phase.",
    expectedIntent: "reviewed",
  })
  expect(messages.at(-1)).toMatchObject({ goal: expect.not.objectContaining({ budget: expect.anything() }) })
  for (const budget of [
    {},
    { activeMs: 1 },
    { modelCost: 0 },
    { modelCost: Number.NaN },
    { recoveryAttempts: 0 },
    { recoveryAttempts: 1.5 },
    { recoveryAttempts: 101 },
    { concurrentChildren: 0 },
    { concurrentChildren: 1.5 },
    { concurrentChildren: 33 },
    { chargeCosts: [] },
    { chargeCosts: [{ currency: "USD" }] },
    { chargeCosts: [{ currency: "usd", limit: 1, reservation: 0.5 }] },
    { chargeCosts: [{ currency: "USD", limit: 1, reservation: 2 }] },
    {
      chargeCosts: [
        { currency: "USD", limit: 1, reservation: 0.5 },
        { currency: "USD", limit: 2, reservation: 0.5 },
      ],
    },
    { recoveryAttempts: 2, unknown: true },
  ])
    await editGoal({ ...context, message: { ...message, budget } as GoalEditMessage })
  expect(calls).toHaveLength(3)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("valid") })
  for (const budgetReason of ["", " ", "x".repeat(241)])
    await editGoal({ ...context, message: { ...message, budgetReason } })
  expect(calls).toHaveLength(3)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("Explain") })
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
