import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { RoutineRefresh } from "../../src/kilo-provider/routine-refresh"
import { RoutineHints } from "../../src/kilo-provider/routine-inference-hints"
import { WorkerHints } from "../../src/kilo-provider/worker-inference-hints"

const { KiloProvider } = await import("../../src/KiloProvider")

const job = (revision = "233cc685-cb12-4a58-8795-9f9c3dd75f41") => ({
  id: "ses_child",
  type: "task",
  status: "running",
  revision,
  started_at: 1,
  metadata: {
    parentSessionId: "ses_parent",
    sessionId: "ses_child",
    childMessageID: "msg_child",
    background: true,
  },
})

function host(client: ReturnType<typeof createKiloClient>) {
  const sent: { type: string; sessionID?: string; error?: string }[] = []
  const state = {
    client,
    connectionState: "connected",
    connectionGeneration: 1,
    contextSessionID: "ses_parent",
    currentSession: null,
    jobsBackoff: 0,
    jobReads: new Map<string, symbol>(),
    workerHints: new WorkerHints(),
    routineHints: new RoutineHints(),
    routineRefresh: new RoutineRefresh(
      () => ({ client: state.client, directory: state.directory, generation: state.connectionGeneration }),
      () => undefined,
    ),
    sessionDirectories: new Map<string, string>(),
    directory: "C:/parent",
    getWorkspaceDirectory: () => state.directory,
    getContextDirectory: () => state.directory,
    isCurrentProjectDirectory: (directory: string) => directory === state.directory,
    isCurrentProjectSession: (id: string) => id === "ses_parent",
    postMessage: (message: (typeof sent)[number]) => sent.push(message),
    routineInferenceHint: (event: unknown, directory?: string): string | undefined =>
      provider.routineInferenceHint.call(state, event, directory),
    workerInferenceHint: (event: unknown, directory?: string): string | undefined =>
      provider.workerInferenceHint.call(state, event, directory),
    inferenceHint: (event: unknown, directory?: string): string | undefined =>
      provider.inferenceHint.call(state, event, directory),
  }
  const provider = KiloProvider.prototype as unknown as {
    fetchAndSendBackgroundJobs: (this: typeof state, id: string, request: string) => Promise<void>
    inferenceHint: (this: typeof state, event: unknown, directory?: string) => string | undefined
    routineInferenceHint: (this: typeof state, event: unknown, directory?: string) => string | undefined
    workerInferenceHint: (this: typeof state, event: unknown, directory?: string) => string | undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(KiloProvider.prototype, "contextSessionID")
  if (!descriptor) throw new Error("Expected the actual provider context boundary")
  Object.defineProperty(state, "contextSessionID", descriptor)
  state.contextSessionID = "ses_parent"
  return { state, sent, refresh: (id = "read") => provider.fetchAndSendBackgroundJobs.call(state, "ses_parent", id) }
}

const hint = { type: "session.inference.changed", properties: { sessionID: "ses_child", queued: 999 } }

test("changed worker invocation removes its old hint before new identity verification", async () => {
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<Response>()
  const current = { jobs: [job()], children: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname.endsWith("background-jobs")) return Response.json(current.jobs)
      if (pathname === "/session/ses_parent")
        return Response.json({ id: "ses_parent", directory: "C:/parent", projectID: "project_original" })
      current.children++
      if (current.children === 1)
        return Response.json({
          id: "ses_child",
          parentID: "ses_parent",
          projectID: "project_original",
          directory: "C:/child-worktree",
        })
      entered.resolve()
      return held.promise
    },
  })
  const ctx = host(createKiloClient({ baseUrl: server.url.toString() }))
  let pending: Promise<void> | undefined
  try {
    await ctx.refresh("original")
    expect(ctx.state.inferenceHint(hint, "C:/child-worktree")).toBe("ses_child")
    current.jobs = [job("51ad9f37-de94-4dba-8d33-86c9f0e08d33")]
    pending = ctx.refresh("replacement")
    await entered.promise
    expect(ctx.state.inferenceHint(hint, "C:/child-worktree")).toBeUndefined()
    expect(ctx.sent.at(-1)?.error).toBeUndefined()
    held.resolve(
      Response.json({
        id: "ses_child",
        parentID: "ses_other",
        projectID: "project_original",
        directory: "C:/child-worktree",
      }),
    )
    await pending
    expect(ctx.state.inferenceHint(hint, "C:/child-worktree")).toBeUndefined()
    expect(ctx.state.jobsBackoff).toBe(0)
  } finally {
    held.resolve(Response.json({}))
    await pending
    await server.stop(true)
  }
})

test("actual SDK worker reads verify a foreign worktree without adopting the child", async () => {
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<Response>()
  const requests: { path: string; directory: string | null }[] = []
  const current = { jobs: [job()] }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push({ path: url.pathname, directory: url.searchParams.get("directory") })
      if (url.pathname.endsWith("background-jobs")) return Response.json(current.jobs)
      if (url.pathname === "/session/ses_parent")
        return Response.json({ id: "ses_parent", directory: "C:/parent", projectID: "project_original" })
      entered.resolve()
      return held.promise
    },
  })
  const ctx = host(createKiloClient({ baseUrl: server.url.toString() }))
  const pending = ctx.refresh()
  try {
    await entered.promise
    expect(ctx.sent).toEqual([
      { type: "backgroundJobsLoaded", sessionID: "ses_parent", requestID: "read", jobs: current.jobs },
    ])
    expect(ctx.state.inferenceHint(hint, "C:/child-worktree")).toBeUndefined()
    held.resolve(
      Response.json({
        id: "ses_child",
        parentID: "ses_parent",
        projectID: "project_original",
        directory: "C:/child-worktree",
      }),
    )
    await pending
    expect(ctx.state.inferenceHint(hint, "C:/child-worktree")).toBe("ses_child")
    expect(ctx.state.inferenceHint(hint, "C:/other")).toBeUndefined()
    expect(ctx.state.inferenceHint(hint, "global")).toBeUndefined()
    expect(
      ctx.state.inferenceHint({ type: "session.updated", properties: hint.properties }, "C:/child-worktree"),
    ).toBeUndefined()
    expect([...ctx.state.sessionDirectories]).toEqual([])
    expect(requests).toEqual([
      { path: "/kilocode/background-jobs", directory: "C:/parent" },
      { path: "/session/ses_parent", directory: "C:/parent" },
      { path: "/session/ses_child", directory: "C:/parent" },
    ])
    await ctx.refresh("cached")
    expect(requests).toHaveLength(4)
    current.jobs = []
    await ctx.refresh("retired")
    expect(ctx.state.inferenceHint(hint, "C:/child-worktree")).toBeUndefined()
    expect(ctx.sent.at(-1)?.error).toBeUndefined()
  } finally {
    held.resolve(Response.json({}))
    await pending
    await server.stop(true)
  }
})

for (const kind of ["parent", "child", "project", "directory", "failure"] as const)
  test(`worker hint verification rejects ${kind} mismatch and leaves polling usable`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.endsWith("background-jobs")) return Response.json([job()])
        if (new URL(request.url).pathname === "/session/ses_parent")
          return Response.json({ id: "ses_parent", directory: "C:/parent", projectID: "project_original" })
        if (kind === "failure") return Response.json({}, { status: 503 })
        return Response.json({
          id: kind === "child" ? "ses_other" : "ses_child",
          parentID: kind === "parent" ? "ses_other" : "ses_parent",
          projectID: kind === "project" ? "project_other" : "project_original",
          directory: kind === "directory" ? "relative/path" : "C:/child-worktree",
        })
      },
    })
    const ctx = host(createKiloClient({ baseUrl: server.url.toString() }))
    try {
      await ctx.refresh()
      expect(ctx.state.inferenceHint(hint, "C:/child-worktree")).toBeUndefined()
      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0]?.error).toBeUndefined()
      expect(ctx.state.jobsBackoff).toBe(0)
      expect(ctx.state.jobReads.size).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

for (const kind of ["client", "generation", "workspace", "context", "contextABA", "refresh"] as const)
  test(`late verified worker directory cannot cross a changed ${kind}`, async () => {
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<Response>()
    const current = { jobs: [job()] }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.endsWith("background-jobs")) return Response.json(current.jobs)
        if (new URL(request.url).pathname === "/session/ses_parent")
          return Response.json({ id: "ses_parent", directory: "C:/parent", projectID: "project_original" })
        entered.resolve()
        return held.promise
      },
    })
    const ctx = host(createKiloClient({ baseUrl: server.url.toString() }))
    const pending = ctx.refresh("old")
    try {
      await entered.promise
      if (kind === "client") ctx.state.client = createKiloClient({ baseUrl: server.url.toString() })
      if (kind === "generation") ctx.state.connectionGeneration++
      if (kind === "workspace") ctx.state.directory = "C:/new"
      if (kind === "context") ctx.state.contextSessionID = "ses_other"
      if (kind === "contextABA") {
        ctx.state.contextSessionID = "ses_other"
        ctx.state.contextSessionID = "ses_parent"
      }
      if (kind === "refresh") {
        current.jobs = []
        await ctx.refresh("new")
      }
      held.resolve(
        Response.json({
          id: "ses_child",
          parentID: "ses_parent",
          projectID: "project_original",
          directory: "C:/child-worktree",
        }),
      )
      await pending
      expect(ctx.state.inferenceHint(hint, "C:/child-worktree")).toBeUndefined()
      expect(ctx.state.sessionDirectories.size).toBe(0)
      expect(ctx.state.jobReads.size).toBe(0)
    } finally {
      held.resolve(Response.json({}))
      await pending
      await server.stop(true)
    }
  })
