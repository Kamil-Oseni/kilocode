import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleRoutineMessage } from "../../src/kilo-provider/routines"

test("snapshot messages use the generated read API and preserve correlation on all outcomes", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      const path = new URL(request.url).pathname
      if (path.includes("/missing/")) return Response.json({}, { status: 404 })
      if (path.includes("/invalid/")) return Response.json({ name: "InvalidRequestError" }, { status: 400 })
      return Response.json({
        version: 1,
        agentID: "routine",
        runID: path.includes("/mismatch/") ? "another" : "saved",
        at: 1234,
        definition: { id: "routine", objective: "Original definition" },
        objective: "Original resolved instructions",
      })
    },
  })
  for (const runID of ["saved", "missing", "invalid", "mismatch"]) {
    await handleRoutineMessage({
      client,
      directory: "workspace",
      post: (msg) => messages.push(msg),
      message: { type: "routineSnapshot", requestID: runID, agentID: "routine", runID },
    })
  }
  expect(calls.map((request) => request.method)).toEqual(["GET", "GET", "GET", "GET"])
  expect(new URL(calls[0]!.url).pathname).toBe("/kilocode/agent/routine/runs/saved/snapshot")
  expect(new URL(calls[0]!.url).searchParams.get("directory")).toBe("workspace")
  expect(messages[0]).toMatchObject({
    type: "routineSnapshot",
    requestID: "saved",
    agentID: "routine",
    runID: "saved",
    snapshot: { objective: "Original resolved instructions" },
  })
  expect(messages[1]).toEqual({
    type: "routineSnapshot",
    requestID: "missing",
    agentID: "routine",
    runID: "missing",
    missing: true,
  })
  expect(messages[2]).toMatchObject({
    type: "routineSnapshot",
    requestID: "invalid",
    runID: "invalid",
    error: expect.stringContaining("could not be read"),
  })
  expect(messages[3]).toMatchObject({
    type: "routineSnapshot",
    requestID: "mismatch",
    runID: "mismatch",
    error: expect.stringContaining("do not match"),
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: { type: "routineSnapshot", requestID: "bad", agentID: "routine", runID: {} },
  })
  expect(calls).toHaveLength(4)
  expect(messages.at(-1)).toMatchObject({
    type: "routineSnapshot",
    requestID: "bad",
    error: expect.stringContaining("Select a saved run"),
  })
  await handleRoutineMessage({
    client: null,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: { type: "routineSnapshot", requestID: "offline", agentID: "routine", runID: "saved" },
  })
  expect(messages.at(-1)).toEqual({
    type: "routineSnapshot",
    requestID: "offline",
    agentID: "routine",
    runID: "saved",
    error: "Raya is not connected.",
  })
})
