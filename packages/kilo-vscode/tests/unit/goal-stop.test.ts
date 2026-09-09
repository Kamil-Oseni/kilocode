import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { stopGoal, stopResult } from "../../src/kilo-provider/goal"

test("saved cancellation attempts distinguish uncertain requests, accepted inputs and registry outcomes", async () => {
  const receipt = { sessionID: "session", intent: "intent", at: 1, finishedAt: 2, interrupted: false }
  const operation = { id: "operation", jobID: "child", revision: "revision", at: 1, phase: "requested" }
  let phase = "cleared"
  let operations: unknown = [operation]
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async () => Response.json({ ...receipt, phase, operations }),
  })
  expect(await stopResult(client, "session")).toContain("job child: requested, no result recorded")
  const replies: unknown[] = []
  await stopGoal({
    client,
    message: { sessionID: "session", requestID: "request", expectedIntent: "intent" },
    post: (reply) => replies.push(reply),
  })
  expect(replies[0]).toMatchObject({ worker: "unconfirmed", background: expect.stringContaining("no result recorded") })
  phase = "finished"
  operations = [{ ...operation, phase: "observed", observedAt: 2, messageID: "input", result: "accepted" }]
  expect(await stopResult(client, "session")).toContain(
    "input input: input cancellation accepted; external termination was not verified",
  )
  await stopGoal({
    client,
    message: { sessionID: "session", requestID: "next", expectedIntent: "intent" },
    post: (reply) => replies.push(reply),
  })
  expect(replies[1]).toMatchObject({
    worker: "preserved",
    background: expect.stringContaining("input cancellation accepted"),
  })
  for (const [result, text] of [
    ["cancelled", "registry reported the job cancelled"],
    ["completed", "registry reported the job already completed"],
    ["not-selected", "not selected by the registry"],
  ]) {
    operations = [{ ...operation, phase: "observed", observedAt: 2, result }]
    expect(await stopResult(client, "session")).toContain(text)
  }
  for (const invalid of [
    [null],
    [operation, operation],
    [{ ...operation, phase: "observed", result: "cancelled" }],
    [{ ...operation, phase: "observed", observedAt: 2, result: "accepted" }],
    [{ ...operation, phase: "observed", observedAt: 2, messageID: "input", result: "cancelled" }],
  ]) {
    operations = invalid
    expect(await stopResult(client, "session")).toContain("attempts could not be verified")
  }
})

test("stop reports saved job identities and separates unavailable checks from empty observations", async () => {
  const receipt = { sessionID: "session", intent: "intent", at: 1, phase: "finished", finishedAt: 2, interrupted: true }
  let snapshot: unknown = { at: 2, status: "checked", jobs: [{ id: "child", type: "task", title: "Check output" }] }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async () => Response.json({ ...receipt, background: snapshot }),
  })
  expect(await stopResult(client, "session")).toContain("Check output (child)")
  expect(await stopResult(client, "session")).toContain("saved snapshot")
  const replies: unknown[] = []
  await stopGoal({
    client,
    message: { sessionID: "session", requestID: "request", expectedIntent: "intent" },
    post: (reply) => replies.push(reply),
  })
  expect(replies[0]).toMatchObject({ cleared: true, background: expect.stringContaining("Check output (child)") })
  snapshot = { at: 2, status: "checked", jobs: [] }
  expect(await stopResult(client, "session")).toContain("No related background jobs were running at the stop check")
  snapshot = { at: 2, status: "unavailable", jobs: [] }
  expect(await stopResult(client, "session")).toContain("could not be checked")
  snapshot = { at: 2, status: "checked", jobs: [null] }
  expect(await stopResult(client, "session")).toContain("could not be checked")
})

test("saved stop discovery uses only GET and keeps unknown results explicit", async () => {
  const calls: Request[] = []
  let status = 200
  let body: unknown = { sessionID: "session", intent: "intent", at: 1, phase: "requested" }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      if (status === 0) throw new Error("offline")
      return Response.json(body, { status })
    },
  })
  expect(await stopResult(client, "session")).toContain("tracking removal and the worker's outcome are unconfirmed")
  body = { sessionID: "session", intent: "intent", at: 1, phase: "cleared" }
  expect(await stopResult(client, "session")).toContain("tracking stopped; the worker's outcome is unconfirmed")
  body = { sessionID: "session", intent: "intent", at: 1, phase: "finished", finishedAt: 2, interrupted: true }
  expect(await stopResult(client, "session")).toContain("its worker was interrupted")
  body = { sessionID: "other", intent: "intent", at: 1, phase: "cleared" }
  expect(await stopResult(client, "session")).toContain("could not be verified")
  status = 404
  expect(await stopResult(client, "session")).toBeUndefined()
  status = 0
  expect(await stopResult(client, "session")).toContain("could not be loaded")
  expect(
    calls.every((call) => call.method === "GET" && new URL(call.url).pathname === "/session/session/goal/stop"),
  ).toBe(true)
})

test("stop requires a reviewed revision and correlates confirmed, rejected and uncertain results", async () => {
  const calls: Request[] = []
  const replies: unknown[] = []
  let status = 200
  const receipt = {
    sessionID: "session",
    intent: "reviewed",
    phase: "finished",
    at: 1,
    finishedAt: 2,
    interrupted: true,
  }
  let body: unknown = receipt
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      if (status === 0) throw new Error("connection lost")
      return Response.json(body, { status })
    },
  })
  const input = {
    client,
    message: { sessionID: "session", requestID: "request", expectedIntent: "reviewed" },
    post: (reply: unknown) => replies.push(reply),
  }
  await stopGoal(input)
  expect(calls[0].method).toBe("POST")
  expect(new URL(calls[0].url).pathname).toBe("/session/session/goal/stop")
  expect(await calls[0].json()).toEqual({ expectedIntent: "reviewed" })
  expect(replies.at(-1)).toEqual({
    type: "goalStopped",
    sessionID: "session",
    requestID: "request",
    cleared: true,
    worker: "interrupted",
  })
  body = { ...receipt, interrupted: false }
  await stopGoal(input)
  expect(replies.at(-1)).toMatchObject({ cleared: true, worker: "preserved" })
  body = { ...receipt, phase: "cleared", interrupted: undefined, finishedAt: undefined }
  await stopGoal(input)
  expect(replies.at(-1)).toMatchObject({ cleared: true, worker: "unconfirmed" })
  body = { ...receipt, intent: "different" }
  await stopGoal(input)
  expect(replies.at(-1)).not.toHaveProperty("cleared")
  status = 409
  body = {}
  await stopGoal(input)
  expect(replies.at(-1)).toMatchObject({ requestID: "request", error: expect.stringContaining("changed") })
  expect(replies.at(-1)).not.toHaveProperty("cleared")
  status = 200
  body = false
  await stopGoal(input)
  expect(replies.at(-1)).toMatchObject({ error: expect.stringContaining("Could not confirm") })
  status = 0
  await stopGoal(input)
  expect(replies.at(-1)).toMatchObject({ error: expect.stringContaining("connection failed") })
  await stopGoal({ ...input, client: null })
  expect(replies.at(-1)).toMatchObject({ error: expect.stringContaining("disconnected") })
  await stopGoal({ ...input, message: { ...input.message, expectedIntent: "" } })
  expect(replies.at(-1)).toMatchObject({ error: expect.stringContaining("Review the goal") })
  expect(calls).toHaveLength(7)
})
