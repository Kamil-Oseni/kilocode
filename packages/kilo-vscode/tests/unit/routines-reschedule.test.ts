import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleRoutineMessage } from "../../src/kilo-provider/routines"

test("an edit preview binds the target, original version and exact confirmed schedule", async () => {
  const calls: { method: string; path: string; body: unknown }[] = []
  const messages: unknown[] = []
  const schedule = { kind: "cron", expr: "0 9 * * 1", tz: "UTC" }
  const edit = {
    agentID: "routine-a",
    expectedSchedule: { kind: "cron", expr: "", tz: "Invalid/Zone" },
    expectedScheduleVersion: 4,
  }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      calls.push({ method: request.method, path, body: await request.json() })
      if (path === "/kilocode/agent-forecast")
        return Response.json({ schedule, from: Date.now(), occurrences: [Date.now() + 3600_000] })
      return Response.json({ id: edit.agentID })
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineForecast", requestID: "preview", schedule, edit },
  })
  const preview = messages[0]
  if (!preview || typeof preview !== "object" || !("forecastID" in preview)) throw new Error("Missing preview")
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: {
      type: "routineScheduleUpdate",
      requestID: "wrong-target",
      agentID: "routine-b",
      forecastID: preview.forecastID,
    },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineCreate", forecastID: preview.forecastID },
  })
  expect(calls).toHaveLength(1)
  const message = {
    type: "routineScheduleUpdate",
    requestID: "save",
    agentID: edit.agentID,
    forecastID: preview.forecastID,
    expectedScheduleVersion: 999,
    schedule: { kind: "manual" },
  }
  await handleRoutineMessage({ client, directory: "workspace", post, message })
  expect(calls[1]).toEqual({
    method: "PATCH",
    path: "/kilocode/agent/routine-a",
    body: { schedule, expectedSchedule: edit.expectedSchedule, expectedScheduleVersion: 4 },
  })
  expect(messages.at(-1)).toEqual({ type: "routineScheduleUpdated", requestID: "save", agentID: "routine-a" })
  await handleRoutineMessage({ client, directory: "workspace", post, message })
  expect(calls).toHaveLength(2)
  expect(messages.at(-1)).toMatchObject({
    type: "routineScheduleUpdated",
    requestID: "save",
    agentID: "routine-a",
    error: expect.stringContaining("expired"),
  })
})

test("a stale backend edit reports failure on the correlated update channel", async () => {
  const messages: unknown[] = []
  const edit = { agentID: "routine", expectedSchedule: { kind: "manual" }, expectedScheduleVersion: 1 }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (request.method === "POST")
        return Response.json({ schedule: { kind: "manual" }, from: Date.now(), occurrences: [] })
      return Response.json(
        { message: "This routine's schedule version changed. Reload it and preview your changes again." },
        { status: 400 },
      )
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineForecast", requestID: "preview", schedule: { kind: "manual" }, edit },
  })
  const preview = messages[0]
  if (!preview || typeof preview !== "object" || !("forecastID" in preview)) throw new Error("Missing preview")
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineScheduleUpdate", requestID: "save", agentID: "routine", forecastID: preview.forecastID },
  })
  expect(messages.at(-1)).toMatchObject({
    type: "routineScheduleUpdated",
    requestID: "save",
    agentID: "routine",
    error: expect.stringContaining("version changed"),
  })
  expect(messages).toHaveLength(2)
})

test("a calendar preview whose first occurrence passed must be refreshed", async () => {
  const calls: string[] = []
  const messages: unknown[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request.method)
      return Response.json({
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
        from: Date.now() - 60_000,
        occurrences: [Date.now() - 1],
      })
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineForecast", requestID: "delayed", when: "every morning", tz: "UTC" },
  })
  const preview = messages[0]
  if (!preview || typeof preview !== "object" || !("forecastID" in preview)) throw new Error("Missing preview")
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineCreate", forecastID: preview.forecastID },
  })
  expect(calls).toEqual(["POST"])
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("first previewed time has passed") })
})
