import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleRoutineMessage } from "../../src/kilo-provider/routines"

test("local calendar proposals are preview-only and confirmation saves the resolved instant", async () => {
  const calls: { path: string; body: unknown }[] = []
  const messages: unknown[] = []
  const proposal = { kind: "local", local: "2090-01-10T09:00", tz: "America/Toronto", fold: "reject" }
  const schedule = { kind: "once", at: Date.parse("2090-01-10T14:00:00Z") }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      const body: unknown = request.method === "GET" ? undefined : await request.json()
      calls.push({ path, body })
      if (path === "/kilocode/agent-forecast")
        return Response.json({ schedule, from: Date.now(), occurrences: [schedule.at], timezone: "America/Toronto" })
      if (request.method === "POST") return Response.json({ id: "created" })
      return Response.json([])
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineCreate", schedule: proposal },
  })
  expect(calls).toHaveLength(0)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("valid schedule") })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineForecast", requestID: "local", schedule: proposal },
  })
  expect(calls[0]?.body).toEqual(proposal)
  const reply = messages.at(-1)
  expect(reply).toMatchObject({ schedule, timezone: "America/Toronto" })
  if (!reply || typeof reply !== "object" || !("forecastID" in reply)) throw new Error("Missing preview")
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: {
      type: "routineCreate",
      forecastID: reply.forecastID,
      schedule: { ...proposal, local: "2090-02-10T09:00" },
    },
  })
  expect(calls.find((call) => call.path === "/kilocode/agent" && call.body)?.body).toMatchObject({ schedule })
})

test("structured preview messages bypass phrase guessing and reject malformed schedules", async () => {
  const requests: unknown[] = []
  const messages: unknown[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const schedule: unknown = await request.json()
      requests.push(schedule)
      return Response.json({ schedule, from: Date.now(), occurrences: [] })
    },
  })
  const schedule = { kind: "cron", expr: "30 9 * * 1,5", tz: "America/Toronto" }
  const post = (msg: unknown) => messages.push(msg)
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: {
      type: "routineForecast",
      requestID: "structured",
      schedule,
      when: "every 2 hours",
    },
  })
  expect(requests).toEqual([schedule])
  expect(messages[0]).toMatchObject({ type: "routineForecast", requestID: "structured", schedule })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: {
      type: "routineForecast",
      requestID: "invalid-structured",
      schedule: { kind: "manual", expr: "0 9 * * *" },
    },
  })
  expect(requests).toHaveLength(1)
  expect(messages.at(-1)).toMatchObject({
    type: "routineForecast",
    requestID: "invalid-structured",
    error: "Choose a valid schedule and preview it again.",
  })
})

test("does not resubmit a preview after an uncertain creation response", async () => {
  const calls: string[] = []
  const messages: unknown[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      calls.push(path)
      if (path === "/kilocode/agent-forecast")
        return Response.json({ schedule: { kind: "manual" }, from: Date.now(), occurrences: [] })
      throw new Error("Connection closed after submitting assignment")
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineForecast", requestID: "uncertain", when: "manual" },
  })
  const reply = messages[0]
  if (!reply || typeof reply !== "object" || !("forecastID" in reply)) throw new Error("Missing preview")
  const input = {
    client,
    directory: "workspace",
    post,
    message: { type: "routineCreate", forecastID: reply.forecastID },
  }
  await Promise.all([handleRoutineMessage(input), handleRoutineMessage(input)])
  await handleRoutineMessage(input)
  expect(calls).toEqual(["/kilocode/agent-forecast", "/kilocode/agent"])
  expect(messages.at(-1)).toMatchObject({ type: "routineState", error: expect.stringContaining("already submitted") })
})

test("confirms the backend's exact schedule and scopes preview tokens to client and directory", async () => {
  const schedule = { kind: "once", at: Date.now() + 3600_000 }
  const calls: { path: string; body: unknown }[] = []
  const messages: unknown[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      const body: unknown = request.method === "GET" ? undefined : await request.json()
      calls.push({ path, body })
      if (path === "/kilocode/agent-forecast")
        return Response.json({ schedule, from: Date.now(), occurrences: [schedule.at] })
      if (request.method === "POST") return Response.json({ id: "created" })
      return Response.json([])
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  await handleRoutineMessage({
    client,
    directory: "workspace-a",
    post,
    message: {
      type: "routineForecast",
      requestID: "preview-a",
      when: "in 1 hour",
      tz: "America/Toronto",
    },
  })
  expect(calls).toHaveLength(1)
  expect(messages[0]).toMatchObject({
    type: "routineForecast",
    requestID: "preview-a",
    schedule,
    occurrences: [schedule.at],
  })
  const reply = messages[0]
  if (!reply || typeof reply !== "object" || !("forecastID" in reply) || typeof reply.forecastID !== "string")
    throw new Error("Missing preview token")
  const message = { type: "routineCreate", forecastID: reply.forecastID, when: "in 2 hours" }
  await handleRoutineMessage({ client, directory: "workspace-b", post, message })
  expect(calls).toHaveLength(1)
  expect(messages.at(-1)).toMatchObject({ type: "routineState", error: expect.stringContaining("preview has expired") })
  await handleRoutineMessage({ client: createKiloClient(), directory: "workspace-a", post, message })
  expect(calls).toHaveLength(1)
  expect(messages.at(-1)).toMatchObject({ type: "routineState", error: expect.stringContaining("preview has expired") })
  await handleRoutineMessage({ client, directory: "workspace-a", post, message })
  expect(calls[1]).toMatchObject({ path: "/kilocode/agent", body: { schedule } })
  expect(calls[2]).toMatchObject({ path: "/kilocode/agent" })
  expect(calls[3]).toMatchObject({ path: "/kilocode/agent-inbox" })
  expect(calls).toHaveLength(4)
  await handleRoutineMessage({ client, directory: "workspace-a", post, message })
  expect(calls).toHaveLength(4)
  expect(messages.at(-1)).toMatchObject({ type: "routineState", error: expect.stringContaining("preview has expired") })
})

test("forwards an explicit calendar timezone through the generated forecast client", async () => {
  const requests: unknown[] = []
  const messages: unknown[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(await request.json())
      return Response.json({ message: "Use a valid timezone for this routine." }, { status: 400 })
    },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: {
      type: "routineForecast",
      requestID: "preview-zone",
      when: "every Monday at 9am",
      tz: "Invalid/Zone",
    },
  })
  expect(requests).toEqual([{ kind: "cron", expr: "0 9 * * 1", tz: "Invalid/Zone" }])
  expect(messages).toEqual([
    { type: "routineForecast", requestID: "preview-zone", error: "Use a valid timezone for this routine." },
  ])
})
