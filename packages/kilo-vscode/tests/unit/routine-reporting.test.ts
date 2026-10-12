import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { RoutineReporting, reports } from "../../src/kilo-provider/routine-reporting"

test("a report load queued between drain completion and finalization is joined and delivered", async () => {
  const client = createKiloClient({ baseUrl: "http://127.0.0.1:1" })
  const messages: string[] = []
  const next = Promise.withResolvers<void>()
  const state = { reads: 0 }
  const reporting = new RoutineReporting(
    () => ({ client, directory: "workspace", generation: 1, sessionID: "origin" }),
    async () => {
      state.reads++
      return []
    },
    (message) => {
      messages.push(message.requestID)
      if (message.requestID !== "first") return
      // The first microtask precedes drain's await continuation; its sibling
      // reaches load after drain returns but before the active finalizer.
      queueMicrotask(() => {
        queueMicrotask(() => {
          void reporting.load({ requestID: "second", sessionID: "origin" }).then(next.resolve, next.reject)
        })
      })
    },
  )
  try {
    await reporting.load({ requestID: "first", sessionID: "origin" })
    await next.promise
    expect(state.reads).toBe(2)
    expect(messages).toEqual(["first", "second"])
  } finally {
    reporting.dispose()
  }
})

test("authoritative routine cards survive a failed refresh without transcript or notice fabrication", async () => {
  const paths: string[] = []
  const card = {
    version: 1,
    id: "original-occurrence",
    agentID: "worker",
    name: "Worker",
    reportSessionID: "origin",
    projectID: "project",
    directory: "workspace",
    revision: 2,
    status: "queued",
    at: 1,
    summary: "Retained work",
    delivery: "delivered",
    notice: { at: 1, reason: "busy" },
  }
  const state = { fail: false, revision: 2 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Basic ${btoa("kilo:synthetic-only")}`)
      paths.push(request.method + " " + new URL(request.url).pathname + new URL(request.url).search)
      if (state.fail) return new Response("Private error must not reach UI", { status: 503 })
      return Response.json([
        {
          ...card,
          revision: state.revision,
          ...(state.revision >= 3
            ? { status: "running", runID: "original-run", workerSessionID: "worker-session" }
            : {}),
        },
      ])
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const messages: Record<string, unknown>[] = []
  const reporting = new RoutineReporting(
    () => ({ client, directory: "workspace", generation: 1, sessionID: "origin" }),
    (_client, directory, sessionID, signal) =>
      reports({ baseUrl: server.url.toString(), password: "synthetic-only" }, directory, sessionID, signal),
    (message) => messages.push(message),
  )
  try {
    await reporting.load({ requestID: "view", sessionID: "origin" })
    expect(messages.at(-1)).toEqual({
      type: "agentReportsLoaded",
      requestID: "view",
      sessionID: "origin",
      items: [card],
    })
    state.fail = true
    await reporting.hint()
    expect(messages.at(-1)).toMatchObject({ type: "agentReportsLoaded", requestID: "view", sessionID: "origin" })
    expect(messages.at(-1)?.items).toBeUndefined()
    expect(messages.at(-1)?.error).toContain("Previously loaded cards are retained")
    expect(JSON.stringify(messages)).not.toContain("Private backend")
    state.fail = false
    state.revision = 1
    await reporting.hint()
    expect(messages.at(-1)?.items).toBeUndefined()
    state.revision = 3
    await reporting.load({ requestID: "reopened", sessionID: "origin" })
    expect(messages.at(-1)).toMatchObject({
      requestID: "reopened",
      items: [{ ...card, revision: 3, status: "running", runID: "original-run", workerSessionID: "worker-session" }],
    })
    expect(paths).toEqual(Array(4).fill("GET /kilocode/agent-reports?sessionID=origin&directory=workspace"))
    expect(messages.every((message) => message.type === "agentReportsLoaded")).toBe(true)
  } finally {
    reporting.dispose()
    await server.stop(true)
  }
})

test("held original report response cannot cross connection generation or originating session", async () => {
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      reached.resolve()
      await release.promise
      return Response.json([
        {
          version: 1,
          id: "original-occurrence",
          agentID: "worker",
          name: "Worker",
          reportSessionID: "origin",
          projectID: "project",
          directory: "workspace",
          revision: 1,
          status: "queued",
          at: 1,
          summary: "Retained work",
          delivery: "delivered",
        },
      ])
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const scope = { client, directory: "workspace", generation: 1, sessionID: "origin" }
  const messages: Record<string, unknown>[] = []
  const reporting = new RoutineReporting(
    () => scope,
    (_client, directory, sessionID, signal) =>
      reports({ baseUrl: server.url.toString(), password: "synthetic-only" }, directory, sessionID, signal),
    (message) => messages.push(message),
  )
  try {
    const pending = reporting.load({ requestID: "old-view", sessionID: "origin" })
    await reached.promise
    scope.generation++
    scope.sessionID = "replacement"
    release.resolve()
    await pending
    expect(messages).toEqual([])
  } finally {
    release.resolve()
    reporting.dispose()
    await server.stop(true)
  }
})
