import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { RoutineReporting, reports } from "../../src/kilo-provider/routine-reporting"
import { ReportPage } from "../../src/shared/routine-reports"

function row(id: string) {
  return {
    version: 1,
    id,
    agentID: "worker",
    name: "Worker",
    reportSessionID: "origin",
    projectID: "project",
    directory: "workspace",
    revision: 1,
    status: "complete",
    at: 1,
    summary: "Retained result",
    delivery: "delivered",
  }
}

test("generated page SDK preserves authenticated opaque cursor and canonical bootstrap metadata", async () => {
  const cursor = "opaque?雪=+"
  const page = ReportPage.parse({
    items: [row("historical")],
    next: "next-original",
    bootstrap: { complete: true, scanned: 700, total: 700 },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      expect(request.method).toBe("GET")
      expect(request.headers.get("authorization")).toBe(`Basic ${btoa("kilo:synthetic-only")}`)
      expect(url.pathname).toBe("/kilocode/agent-reports/page")
      expect(url.searchParams.get("directory")).toBe("Private Workspace")
      expect(url.searchParams.get("sessionID")).toBe("origin")
      expect(url.searchParams.get("cursor")).toBe(cursor)
      expect(url.searchParams.get("limit")).toBe("200")
      return Response.json(page)
    },
  })
  const client = createKiloClient({
    baseUrl: server.url.toString(),
    headers: { Authorization: `Basic ${btoa("kilo:synthetic-only")}` },
  })
  try {
    expect(await reports(client, "Private Workspace", "origin", new AbortController().signal, cursor)).toEqual(page)
  } finally {
    await server.stop(true)
  }
})

test("explicit historical report pages retain cursor and bootstrap without live latest replacement", async () => {
  const client = createKiloClient({ baseUrl: "http://127.0.0.1:1" })
  const calls: (string | undefined)[] = []
  const messages: Record<string, unknown>[] = []
  const state = { fail: false }
  const reporting = new RoutineReporting(
    () => ({ client, directory: "workspace", generation: 1, sessionID: "origin" }),
    async (_client, _directory, _session, _signal, cursor) => {
      calls.push(cursor)
      if (state.fail) throw new Error("Unavailable original page")
      return ReportPage.parse({
        items: [row(cursor ?? "latest")],
        next: cursor === undefined ? "older" : "oldest",
        bootstrap: { complete: false, scanned: 64, total: 700 },
      })
    },
    (message) => messages.push(message),
  )
  try {
    await reporting.load({ requestID: "first", sessionID: "origin" })
    await reporting.load({ requestID: "history", sessionID: "origin", cursor: "older" })
    await reporting.hint()
    expect(calls).toEqual([undefined, "older"])
    expect(messages.at(-1)).toMatchObject({
      requestID: "history",
      cursor: "older",
      next: "oldest",
      bootstrap: { complete: false, scanned: 64, total: 700 },
      items: [{ id: "older" }],
    })
    state.fail = true
    await reporting.load({ requestID: "unavailable", sessionID: "origin", cursor: "oldest" })
    expect(messages.at(-1)).toMatchObject({ requestID: "unavailable", cursor: "oldest" })
    expect(messages.at(-1)?.items).toBeUndefined()
    expect(messages.at(-1)?.next).toBeUndefined()
    expect(messages.at(-1)?.bootstrap).toBeUndefined()
    state.fail = false
    await reporting.load({ requestID: "refresh", sessionID: "origin" })
    expect(messages.at(-1)).toMatchObject({ requestID: "refresh", items: [{ id: "latest" }] })
    expect(messages.at(-1)?.cursor).toBeUndefined()
  } finally {
    reporting.dispose()
  }
})

test("late original historical page cannot overwrite a fresh latest-page request", async () => {
  const client = createKiloClient({ baseUrl: "http://127.0.0.1:1" })
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const messages: Record<string, unknown>[] = []
  const reporting = new RoutineReporting(
    () => ({ client, directory: "workspace", generation: 1, sessionID: "origin" }),
    async (_client, _directory, _session, _signal, cursor) => {
      if (cursor) {
        reached.resolve()
        await release.promise
      }
      return ReportPage.parse({ items: [row(cursor ?? "latest")] })
    },
    (message) => messages.push(message),
  )
  try {
    const original = reporting.load({ requestID: "history", sessionID: "origin", cursor: "older" })
    await reached.promise
    const latest = reporting.load({ requestID: "refresh", sessionID: "origin" })
    release.resolve()
    await Promise.all([original, latest])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ requestID: "refresh", items: [{ id: "latest" }] })
  } finally {
    release.resolve()
    reporting.dispose()
  }
})

test("a report load queued between drain completion and finalization is joined and delivered", async () => {
  const client = createKiloClient({ baseUrl: "http://127.0.0.1:1" })
  const messages: string[] = []
  const next = Promise.withResolvers<void>()
  const state = { reads: 0 }
  const reporting = new RoutineReporting(
    () => ({ client, directory: "workspace", generation: 1, sessionID: "origin" }),
    async () => {
      state.reads++
      return { items: [] }
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
      return Response.json({
        items: [
          {
            ...card,
            revision: state.revision,
            ...(state.revision >= 3
              ? { status: "running", runID: "original-run", workerSessionID: "worker-session" }
              : {}),
          },
        ],
      })
    },
  })
  const client = createKiloClient({
    baseUrl: server.url.toString(),
    headers: { Authorization: `Basic ${btoa("kilo:synthetic-only")}` },
  })
  const messages: Record<string, unknown>[] = []
  const reporting = new RoutineReporting(
    () => ({ client, directory: "workspace", generation: 1, sessionID: "origin" }),
    reports,
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
    expect(paths).toEqual(
      Array(4).fill("GET /kilocode/agent-reports/page?directory=workspace&sessionID=origin&limit=200"),
    )
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
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Basic ${btoa("kilo:synthetic-only")}`)
      reached.resolve()
      await release.promise
      return Response.json({
        items: [
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
        ],
      })
    },
  })
  const client = createKiloClient({
    baseUrl: server.url.toString(),
    headers: { Authorization: `Basic ${btoa("kilo:synthetic-only")}` },
  })
  const scope = { client, directory: "workspace", generation: 1, sessionID: "origin" }
  const messages: Record<string, unknown>[] = []
  const reporting = new RoutineReporting(
    () => scope,
    reports,
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
