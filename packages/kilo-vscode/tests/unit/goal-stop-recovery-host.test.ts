import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { stopGoal } from "../../src/kilo-provider/goal"

const receipt = {
  sessionID: "ses_recovery",
  intent: "original-stop-intent",
  phase: "cleared",
  at: 1,
  interrupted: false,
  task: {
    version: 1,
    stop: { version: 1, intent: "original-stop-intent", at: 1 },
    sessionDigest: "a".repeat(64),
    runs: [
      {
        id: "run_original",
        agentID: "agent_original",
        sessionID: "ses_recovery",
        at: 1,
        scheduleVersion: 1,
        executionDigest: "b".repeat(64),
        trigger: { kind: "manual" },
      },
    ],
  },
}
const message = {
  sessionID: receipt.sessionID,
  requestID: "request_original",
  expectedIntent: receipt.intent,
  retry: true,
}

for (const stage of ["goal", "receipt", "mutation"] as const)
  for (const kind of ["client", "generation", "directory"] as const)
    test(`actual Stop recovery refuses stale ${kind} while ${stage} read is held`, async () => {
      const entered = Promise.withResolvers<void>()
      const held = Promise.withResolvers<Response>()
      const requests: Request[] = []
      const replies: unknown[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(request.clone())
          const goal = new URL(request.url).pathname.endsWith("/goal")
          // The POST fallback makes the existing unsafe implementation fail
          // behaviorally instead of waiting forever for an absent preflight.
          if (request.method === "POST" || (stage === "goal" ? goal : stage === "receipt" && !goal)) {
            entered.resolve()
            return held.promise.then((response) => response.clone())
          }
          return goal ? Response.json({ error: "No current goal" }, { status: 404 }) : Response.json(receipt)
        },
      })
      const client = createKiloClient({ baseUrl: server.url.toString() })
      const state = { client, generation: 1, directory: "C:/original" }
      const input = {
        client,
        directory: state.directory,
        message,
        current: () => state.client === client && state.generation === 1 && state.directory === "C:/original",
        post: (reply: unknown) => replies.push(reply),
      }
      const pending = stopGoal(input)
      try {
        await entered.promise
        if (kind === "client") state.client = createKiloClient({ baseUrl: server.url.toString() })
        if (kind === "generation") state.generation++
        if (kind === "directory") state.directory = "C:/replacement"
        held.resolve(
          stage === "goal"
            ? Response.json({ error: "No current goal" }, { status: 404 })
            : Response.json(stage === "mutation" ? { ...receipt, phase: "finished", finishedAt: 2 } : receipt),
        )
        await pending
        expect(requests.filter((request) => request.method === "POST")).toHaveLength(stage === "mutation" ? 1 : 0)
        expect(replies).toEqual([])
      } finally {
        held.resolve(Response.json({}, { status: 503 }))
        await pending
        await server.stop(true)
      }
    })

for (const kind of [
  "new-goal",
  "unknown-goal",
  "unknown-receipt",
  "unknown-cancel",
  "wrong-intent",
  "wrong-session",
  "wrong-task",
  "wrong-task-session",
  "malformed-task",
  "finished",
  "requested",
] as const)
  test(`actual Stop recovery sends no mutation for ${kind}`, async () => {
    const requests: Request[] = []
    const replies: unknown[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(request.clone())
        if (new URL(request.url).pathname.endsWith("/goal")) {
          if (kind === "new-goal") return Response.json({ intent: "newer-goal", status: "paused" })
          return Response.json({ error: "Goal unavailable" }, { status: kind === "unknown-goal" ? 503 : 404 })
        }
        if (kind === "unknown-receipt") return Response.json({ error: "Receipt unavailable" }, { status: 503 })
        if (kind === "unknown-cancel") return Response.json({ ...receipt, interrupted: undefined })
        if (kind === "wrong-intent") return Response.json({ ...receipt, intent: "other-intent" })
        if (kind === "wrong-session") return Response.json({ ...receipt, sessionID: "ses_other" })
        if (kind === "wrong-task")
          return Response.json({
            ...receipt,
            task: { ...receipt.task, stop: { ...receipt.task.stop, intent: "other-intent" } },
          })
        if (kind === "wrong-task-session")
          return Response.json({
            ...receipt,
            task: { ...receipt.task, runs: [{ ...receipt.task.runs[0], sessionID: "ses_other" }] },
          })
        if (kind === "malformed-task") return Response.json({ ...receipt, task: { version: 1 } })
        if (kind === "finished") return Response.json({ ...receipt, phase: "finished", finishedAt: 2 })
        if (kind === "requested") return Response.json({ ...receipt, phase: "requested" })
        return Response.json(receipt)
      },
    })
    try {
      const input = {
        client: createKiloClient({ baseUrl: server.url.toString() }),
        directory: "C:/original",
        message,
        current: () => true,
        post: (reply: unknown) => replies.push(reply),
      }
      await stopGoal(input)
      expect(requests.filter((request) => request.method === "POST")).toHaveLength(0)
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({
        requestID: message.requestID,
        sessionID: receipt.sessionID,
        error: expect.any(String),
      })
      expect(replies[0]).not.toHaveProperty("cleared")
    } finally {
      await server.stop(true)
    }
  })

test("actual Stop recovery makes one same-intent POST and never retries an unknown outcome", async () => {
  for (const lost of [false, true]) {
    const requests: Request[] = []
    const replies: unknown[] = []
    const client = createKiloClient({
      baseUrl: "http://127.0.0.1:4096",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request.clone())
        if (request.method === "GET")
          return new URL(request.url).pathname.endsWith("/goal")
            ? Response.json({ error: "No current goal" }, { status: 404 })
            : Response.json(receipt)
        if (lost) throw new Error("Original POST outcome is unknown")
        return Response.json({ ...receipt, phase: "finished", finishedAt: 2 })
      },
    })
    const input = {
      client,
      directory: "C:/original",
      message,
      current: () => true,
      post: (reply: unknown) => replies.push(reply),
    }
    await stopGoal(input)
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "POST"])
    expect(requests.every((request) => new URL(request.url).searchParams.get("directory") === "C:/original")).toBe(true)
    expect(await requests[2]!.json()).toEqual({ expectedIntent: receipt.intent })
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ requestID: message.requestID, sessionID: receipt.sessionID })
    if (lost) {
      expect(replies[0]).toHaveProperty("error")
      expect(replies[0]).not.toHaveProperty("cleared")
    }
    if (!lost) expect(replies[0]).toMatchObject({ cleared: true, worker: "preserved" })
  }
})
