import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { Capabilities } from "../../src/services/cli-backend/capabilities"
import { editGoal } from "../../src/kilo-provider/goal"

test("bound goal edits require a supported authenticated contract before any mutation", async () => {
  const calls: { method: string; authorization: string | null }[] = []
  const criteria = [
    {
      id: "tests",
      description: "Tests pass",
      verification: "Run the suite",
      required: true,
      check: { kind: "command" as const, command: "bun test", directory: "C:/workspace" },
    },
  ]
  let response = Response.json({}, { status: 404 })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls.push({ method: request.method, authorization: request.headers.get("authorization") })
      if (new URL(request.url).pathname === "/kilocode/capabilities") return response.clone()
      return Response.json({
        objective: "Goal",
        intent: "saved",
        status: "paused",
        createdAt: 1,
        updatedAt: 2,
        usage: { turns: 0, continuations: 0, toolCalls: 0 },
        progress: [],
        criteria,
      })
    },
  })
  try {
    const config = { baseUrl: server.url.origin, password: "secret" }
    const client = createKiloClient({ baseUrl: config.baseUrl })
    const capabilities = new Capabilities(() => ({ client, config }))
    const messages: unknown[] = []
    const input = {
      client,
      authorize: (value: typeof client) => capabilities.command(value),
      message: {
        type: "goalEdit",
        sessionID: "session",
        requestID: "request",
        expectedIntent: "reviewed",
        objective: "Goal",
        criteria,
      },
      post: (value: unknown) => messages.push(value),
    }
    for (const value of [
      Response.json({}, { status: 404 }),
      Response.json({ version: 2, features: { "goal.commandCheck": 1 } }),
      Response.json({ version: 1, features: { "goal.commandCheck": 2 } }),
      Response.json({ version: 1, features: {} }),
      new Response("invalid json"),
      Response.json({}, { status: 503 }),
    ]) {
      response = value
      await editGoal(input)
      expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("no goal update was sent") })
      expect(calls.every((request) => request.method === "GET")).toBe(true)
    }
    expect(calls[0].authorization).toBe(`Basic ${Buffer.from("kilo:secret").toString("base64")}`)
    response = Response.json({ version: 1, features: { "goal.commandCheck": 1 }, future: true })
    await editGoal(input)
    expect(messages.at(-1)).toMatchObject({ goal: { criteria } })
    expect(calls.filter((request) => request.method === "PATCH")).toHaveLength(1)
    const probes = calls.filter((request) => request.method === "GET").length
    await editGoal(input)
    expect(calls.filter((request) => request.method === "GET")).toHaveLength(probes)
    await editGoal({ ...input, authorize: undefined })
    expect(calls.filter((request) => request.method === "PATCH")).toHaveLength(2)
    await editGoal({ ...input, authorize: undefined, message: { ...input.message, criteria: undefined } })
    expect(calls.filter((request) => request.method === "PATCH")).toHaveLength(3)
  } finally {
    await server.stop(true)
  }
})

test("replacement connections cannot inherit pending or cached support even at the same origin", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let probes = 0
  let supported = true
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      probes++
      if (probes === 1) {
        entered.resolve()
        await release.promise
      }
      return Response.json({ version: 1, features: { "goal.commandCheck": supported ? 1 : 2 } })
    },
  })
  try {
    const config = { baseUrl: server.url.origin, password: "secret" }
    const first = createKiloClient({ baseUrl: config.baseUrl })
    let current: { client: typeof first; config: typeof config } | undefined = { client: first, config }
    const capabilities = new Capabilities(() => current)
    const pending = capabilities.command(first)
    const messages: unknown[] = []
    const editing = editGoal({
      client: first,
      authorize: (client) => capabilities.command(client),
      message: {
        type: "goalEdit",
        sessionID: "session",
        requestID: "replacement",
        expectedIntent: "reviewed",
        objective: "Goal",
        criteria: [
          {
            id: "test",
            description: "Pass",
            verification: "Run",
            required: true,
            check: { kind: "command", command: "bun test", directory: "C:/workspace" },
          },
        ],
      },
      post: (message) => messages.push(message),
    })
    await entered.promise
    current = { client: createKiloClient({ baseUrl: config.baseUrl }), config }
    release.resolve()
    expect((await pending)()).toBe(false)
    await editing
    expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("no goal update was sent") })
    expect(probes).toBe(1)
    supported = false
    expect((await capabilities.command(current.client))()).toBe(false)
    expect(probes).toBe(2)
    supported = true
    const permit = await capabilities.command(current.client)
    expect(permit()).toBe(true)
    current = undefined
    expect(permit()).toBe(false)
    expect((await capabilities.command(first))()).toBe(false)
  } finally {
    release.resolve()
    await server.stop(true)
  }
})
