import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleRoutineMessage } from "../../src/kilo-provider/routines"

test("output editing sends a conditional PATCH and rejects missing preconditions and mismatched acknowledgements", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  const output = {
    destination: "conversation",
    description: "Report",
    criteria: [{ id: "sources", description: "List sources", verification: "Check references" }],
  }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return Response.json({ id: "routine", output })
    },
  })
  const context = { client, directory: "workspace", post: (msg: unknown) => messages.push(msg) }
  const message = {
    type: "routineOutputUpdate",
    requestID: "edit",
    agentID: "routine",
    output,
    expectedOutput: "unset",
  }
  await handleRoutineMessage({ ...context, message })
  expect(calls).toHaveLength(1)
  expect(calls[0].method).toBe("PATCH")
  expect(new URL(calls[0].url).searchParams.get("directory")).toBe("workspace")
  expect(await calls[0].json()).toEqual({ output, expectedOutput: "unset" })
  expect(messages[0]).toMatchObject({ type: "routineOutputUpdated", requestID: "edit", agentID: "routine", output })
  await handleRoutineMessage({ ...context, message: { ...message, expectedOutput: undefined } })
  expect(calls).toHaveLength(1)
  expect(messages.at(-1)).toMatchObject({ type: "routineOutputUpdated", error: expect.any(String) })
  await handleRoutineMessage({ ...context, client: null, message })
  expect(messages.at(-1)).toMatchObject({
    type: "routineOutputUpdated",
    requestID: "edit",
    error: "Raya is not connected.",
  })
  await handleRoutineMessage({
    ...context,
    message: { ...message, output: { ...output, description: "Changed report" } },
  })
  expect(messages.at(-1)).toMatchObject({
    type: "routineOutputUpdated",
    error: expect.stringContaining("could not be confirmed"),
  })
})

test("routine creation validates output before consuming preview and forwards the contract through the generated client", async () => {
  const calls: { method: string; path: string; body: unknown }[] = []
  const messages: unknown[] = []
  const schedule = { kind: "manual" }
  const output = {
    destination: "conversation",
    description: "Source review",
    criteria: [{ id: "sources", description: "Cite each source", verification: "Check that each citation resolves" }],
  }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      calls.push({
        method: request.method,
        path: url.pathname,
        body: request.method === "GET" ? undefined : await request.json(),
      })
      if (url.pathname === "/kilocode/agent-forecast")
        return Response.json({ schedule, from: Date.now(), occurrences: [] })
      if (request.method === "POST") return Response.json({ id: "saved", output })
      return Response.json([])
    },
  })
  const context = { client, directory: "workspace", post: (message: unknown) => messages.push(message) }
  await handleRoutineMessage({ ...context, message: { type: "routineForecast", requestID: "output", schedule } })
  const reply = messages.at(-1)
  if (!reply || typeof reply !== "object" || !("forecastID" in reply)) throw new Error("Missing preview")
  for (const invalid of [
    { ...output, description: " " },
    { ...output, destination: "email" },
    { ...output, criteria: [] },
    { ...output, criteria: [output.criteria[0], output.criteria[0]] },
    { ...output, criteria: [{ ...output.criteria[0], verification: "" }] },
  ]) {
    await handleRoutineMessage({
      ...context,
      message: { type: "routineCreate", forecastID: reply.forecastID, output: invalid },
    })
    expect(calls).toHaveLength(1)
    expect(messages.at(-1)).toMatchObject({ type: "routineState", error: expect.any(String) })
  }
  await handleRoutineMessage({
    ...context,
    message: { type: "routineCreate", forecastID: reply.forecastID, objective: "Review sources", output },
  })
  expect(calls.filter((item) => item.path === "/kilocode/agent" && item.method === "POST")).toEqual([
    { path: "/kilocode/agent", method: "POST", body: expect.objectContaining({ output, schedule }) },
  ])
})
