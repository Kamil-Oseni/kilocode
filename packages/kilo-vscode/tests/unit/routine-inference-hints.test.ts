import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { RoutineHints } from "../../src/kilo-provider/routine-inference-hints"
import { RoutineRefresh } from "../../src/kilo-provider/routine-refresh"
import { WorkerHints } from "../../src/kilo-provider/worker-inference-hints"

const { KiloProvider } = await import("../../src/KiloProvider")

function records() {
  const run = {
    id: "run_original",
    agentID: "routine_original",
    at: 100,
    revision: 1,
    sessionID: "ses_routine",
    status: "running",
    scheduleVersion: 1,
    trigger: { kind: "manual" },
  }
  return {
    agent: { id: run.agentID, dir: "C:/mutable-current-definition" },
    run,
    snapshot: {
      version: 2,
      runID: run.id,
      sessionID: run.sessionID as string | undefined,
      agentID: run.agentID,
      at: run.at,
      definition: { id: run.agentID, scheduleVersion: 1, dir: "D:/worker" },
    },
    session: {
      id: run.sessionID,
      directory: "D:/worker",
      projectID: "different_worker_project",
      metadata: {
        rayaRoutine: {
          version: 1,
          agentID: run.agentID,
          runID: run.id,
          scheduleVersion: 1,
          trigger: { kind: "manual" },
        },
      },
    },
    failed: false,
  }
}

function fixture(hold?: () => Promise<Response>, history?: () => Promise<void>) {
  const data = records()
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push(url.pathname)
      expect(request.method).toBe("GET")
      expect(url.searchParams.get("directory")).toBe("C:/roster")
      if (url.pathname.endsWith("/agent")) return Response.json([data.agent])
      if (url.pathname.endsWith("/organization")) return Response.json({ items: [] })
      if (url.pathname.endsWith("/agent-runs")) {
        await history?.()
        return Response.json({
          items: data.failed ? [] : [{ agentID: data.agent.id, runs: [data.run] }],
          failed: data.failed ? [data.agent.id] : [],
        })
      }
      if (url.pathname.endsWith("/snapshot")) return Response.json(data.snapshot)
      if (url.pathname === "/session/ses_routine") return hold ? hold() : Response.json(data.session)
      return Response.json([])
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const scope = { client, directory: "C:/roster", generation: 1 }
  const hints = new RoutineHints()
  const sent: Record<string, unknown>[] = []
  const refresh = new RoutineRefresh(
    () => scope,
    (message) => sent.push(message),
    30_000,
    hints,
  )
  const state = {
    client,
    connectionState: "connected",
    connectionGeneration: 1,
    contextSessionID: undefined,
    currentSession: null,
    routineHints: hints,
    workerHints: new WorkerHints(),
    sessionDirectories: new Map<string, string>(),
    trackedSessionIds: new Set<string>(),
    getWorkspaceDirectory: () => scope.directory,
    isCurrentProjectDirectory: (directory: string) => directory === scope.directory,
    isCurrentProjectSession: () => false,
    postMessage: (message: Record<string, unknown>) => sent.push(message),
    workerInferenceHint: (event: unknown, directory?: string): string | undefined =>
      provider.workerInferenceHint.call(state, event, directory),
    routineInferenceHint: (event: unknown, directory?: string): string | undefined =>
      provider.routineInferenceHint.call(state, event, directory),
    inferenceHint: (event: unknown, directory?: string): string | undefined =>
      provider.inferenceHint.call(state, event, directory),
  }
  const provider = KiloProvider.prototype as unknown as {
    workerInferenceHint: (this: typeof state, event: unknown, directory?: string) => string | undefined
    routineInferenceHint: (this: typeof state, event: unknown, directory?: string) => string | undefined
    inferenceHint: (this: typeof state, event: unknown, directory?: string) => string | undefined
    handleEvent: (this: typeof state, event: unknown, directory?: string) => void
  }
  return { data, requests, server, scope, hints, sent, refresh, state, provider }
}

const hint = { type: "session.inference.changed", properties: { sessionID: "ses_routine", queued: 99 } }

test("actual Routine refresh verifies immutable startup and Session routes before cross-directory hints", async () => {
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<Response>()
  const ctx = fixture(() => {
    entered.resolve()
    return held.promise
  })
  const pending = ctx.refresh.request("view", "view")
  try {
    await entered.promise
    expect(ctx.sent.some((message) => message.refresh === "complete")).toBe(true)
    expect(ctx.state.inferenceHint(hint, "D:/worker")).toBeUndefined()
    held.resolve(Response.json(ctx.data.session))
    await pending
    expect(ctx.state.inferenceHint(hint, "D:/worker")).toBe("ses_routine")
    expect(ctx.state.inferenceHint(hint, "C:/mutable-current-definition")).toBeUndefined()
    expect(ctx.state.inferenceHint(hint, "D:/foreign")).toBeUndefined()
    expect(ctx.state.inferenceHint(hint, "global")).toBeUndefined()
    ctx.provider.handleEvent.call(ctx.state, hint, "D:/worker")
    expect(ctx.sent.at(-1)).toEqual({ type: "localInferenceChanged", sessionID: "ses_routine" })
    expect(ctx.state.sessionDirectories.size).toBe(0)
    expect(ctx.state.trackedSessionIds.size).toBe(0)
    await ctx.refresh.request("cached", "view")
    expect(ctx.requests.filter((path) => path.endsWith("/snapshot"))).toHaveLength(1)
    expect(ctx.requests.filter((path) => path.startsWith("/session/"))).toHaveLength(1)
    ctx.data.run.status = "complete"
    await ctx.refresh.request("terminal", "view")
    expect(ctx.state.inferenceHint(hint, "D:/worker")).toBeUndefined()
  } finally {
    held.resolve(Response.json({}))
    await pending
    ctx.refresh.dispose()
    ctx.hints.dispose()
    await ctx.server.stop(true)
  }
})

test("clearing hint ownership during delayed history completes the view without admitting an obsolete route", async () => {
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  const ctx = fixture(undefined, () => {
    entered.resolve()
    return held.promise
  })
  const pending = ctx.refresh.request("view", "view")
  try {
    await entered.promise
    expect(ctx.sent.some((message) => message.refresh === "loading")).toBe(true)
    ctx.hints.clear()
    held.resolve()
    await pending
    expect(ctx.sent.filter((message) => message.requestID === "view" && message.refresh === "complete")).toHaveLength(1)
    expect(ctx.sent.some((message) => message.type === "routineRuns" && message.agentID === ctx.data.agent.id)).toBe(
      true,
    )
    expect(ctx.requests.filter((path) => path.endsWith("/snapshot") || path.startsWith("/session/"))).toHaveLength(0)
    expect(ctx.state.inferenceHint(hint, "D:/worker")).toBeUndefined()
    await ctx.refresh.request("retry", "view")
    expect(ctx.sent.some((message) => message.requestID === "retry" && message.refresh === "complete")).toBe(true)
    expect(ctx.state.inferenceHint(hint, "D:/worker")).toBe("ses_routine")
    expect(ctx.requests.filter((path) => path.endsWith("/snapshot"))).toHaveLength(1)
  } finally {
    held.resolve()
    await pending
    ctx.refresh.dispose()
    await ctx.server.stop(true)
  }
})

for (const kind of ["pin", "agent", "at", "schedule", "trigger", "session", "directory", "failure"] as const)
  test(`Routine route proof rejects ${kind} mismatch without hiding the current history`, async () => {
    const ctx = fixture()
    if (kind === "pin") ctx.data.snapshot.sessionID = undefined
    if (kind === "agent") ctx.data.snapshot.definition.id = "different_agent"
    if (kind === "at") ctx.data.snapshot.at++
    if (kind === "schedule") ctx.data.snapshot.definition.scheduleVersion++
    if (kind === "trigger") ctx.data.session.metadata.rayaRoutine.trigger = { kind: "other" }
    if (kind === "session") ctx.data.session.id = "ses_other"
    if (kind === "directory") ctx.data.session.directory = "D:/foreign"
    if (kind === "failure") ctx.data.failed = true
    try {
      await ctx.refresh.request("view", "view")
      expect(ctx.state.inferenceHint(hint, "D:/worker")).toBeUndefined()
      expect(ctx.state.inferenceHint(hint, "D:/foreign")).toBeUndefined()
      expect(ctx.sent.some((message) => message.refresh === (kind === "failure" ? "partial" : "complete"))).toBe(true)
      expect(ctx.state.sessionDirectories.size).toBe(0)
    } finally {
      ctx.refresh.dispose()
      ctx.hints.dispose()
      await ctx.server.stop(true)
    }
  })

for (const kind of ["client", "directory", "generation", "ABA", "dispose"] as const)
  test(`late Routine identity lookup cannot restore hints after ${kind}`, async () => {
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<Response>()
    const ctx = fixture(() => {
      entered.resolve()
      return held.promise
    })
    const pending = ctx.refresh.request("old", "view")
    try {
      await entered.promise
      if (kind === "client") ctx.scope.client = createKiloClient({ baseUrl: ctx.server.url.toString() })
      if (kind === "directory") ctx.scope.directory = "C:/new"
      if (kind === "generation") ctx.scope.generation++
      if (kind === "ABA") {
        ctx.refresh.invalidate()
        ctx.scope.directory = "C:/other"
        ctx.refresh.invalidate()
        ctx.scope.directory = "C:/roster"
      }
      if (kind === "dispose") ctx.refresh.dispose()
      held.resolve(Response.json(ctx.data.session))
      await pending
      expect(ctx.hints.hint("ses_routine", "D:/worker", ctx.scope)).toBe(false)
    } finally {
      held.resolve(Response.json({}))
      await pending
      ctx.refresh.dispose()
      ctx.hints.dispose()
      await ctx.server.stop(true)
    }
  })
