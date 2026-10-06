import { describe, expect, it } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"

const { KiloProvider } = await import("../../src/KiloProvider")

type Reply = { type: string; sessionID: string; requestID: string; jobs: unknown[]; error?: string }
type Context = {
  client: { kilocode: { backgroundJobs: () => Promise<{ data: unknown[] }> } }
  connectionState: "connected"
  jobsBackoff: number
  jobReads: Map<string, symbol>
  getWorkspaceDirectory: () => string
  postMessage: (message: Reply) => void
}

describe("background job refresh", () => {
  it("reports fetch failure and backoff as unavailable, then publishes the recovered worker list", async () => {
    const sent: Reply[] = []
    const jobs = [{ id: "worker", status: "running" }]
    let calls = 0
    const state: Context = {
      client: {
        kilocode: {
          backgroundJobs: async () => {
            calls++
            if (calls === 1) throw new Error("controlled backend failure")
            return { data: jobs }
          },
        },
      },
      connectionState: "connected",
      jobsBackoff: 0,
      jobReads: new Map(),
      getWorkspaceDirectory: () => "C:\\workspace",
      postMessage: (message) => sent.push(message),
    }
    const provider = KiloProvider.prototype as unknown as {
      fetchAndSendBackgroundJobs: (this: Context, sessionID: string, requestID: string) => Promise<void>
    }

    await provider.fetchAndSendBackgroundJobs.call(state, "parent", "first")
    expect(sent[0]).toMatchObject({ requestID: "first", jobs: [], error: expect.any(String) })
    await provider.fetchAndSendBackgroundJobs.call(state, "parent", "backoff")
    expect(sent[1]).toMatchObject({ requestID: "backoff", jobs: [], error: expect.any(String) })
    expect(calls).toBe(1)

    state.jobsBackoff = 0
    await provider.fetchAndSendBackgroundJobs.call(state, "parent", "recovered")
    expect(sent[2]).toEqual({ type: "backgroundJobsLoaded", sessionID: "parent", requestID: "recovered", jobs })
    expect(calls).toBe(2)
  })
})

for (const action of ["refresh", "cancel"] as const)
  for (const status of [200, 503])
    for (const kind of ["client", "generation", "directory"] as const)
      it(`actual SDK ${action} ${status} drops replaced ${kind} scope without poisoning recovery`, async () => {
        const entered = Promise.withResolvers<void>()
        const held = Promise.withResolvers<Response>()
        const sent: Reply[] = []
        const requests: string[] = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            requests.push(request.method)
            if (requests.length > 1) return Response.json([])
            entered.resolve()
            return held.promise
          },
        })
        const workspace = { directory: "C:/original" }
        const state = {
          client: createKiloClient({ baseUrl: server.url.toString() }),
          connectionState: "connected" as const,
          connectionGeneration: 1,
          jobsBackoff: 0,
          jobReads: new Map<string, symbol>(),
          getWorkspaceDirectory: () => workspace.directory,
          postMessage: (message: Reply) => sent.push(message),
          fetchAndSendBackgroundJobs: async (sessionID: string, requestID: string) =>
            provider.fetchAndSendBackgroundJobs.call(state, sessionID, requestID),
        }
        const provider = KiloProvider.prototype as unknown as {
          fetchAndSendBackgroundJobs: (this: typeof state, sessionID: string, requestID: string) => Promise<void>
          cancelBackgroundJob: (
            this: typeof state,
            jobID: string,
            sessionID: string,
            requestID: string,
          ) => Promise<void>
        }
        const pending =
          action === "refresh"
            ? provider.fetchAndSendBackgroundJobs.call(state, "parent", "old")
            : provider.cancelBackgroundJob.call(state, "worker", "parent", "old")
        try {
          await entered.promise
          if (kind === "client") state.client = createKiloClient({ baseUrl: server.url.toString() })
          if (kind === "generation") state.connectionGeneration++
          if (kind === "directory") workspace.directory = "C:/replacement"
          held.resolve(Response.json(status === 200 ? [] : { message: "Old scope unavailable" }, { status }))
          await pending
          expect(sent).toEqual([])
          expect(state.jobsBackoff).toBe(0)
          expect(requests).toHaveLength(1)
          if (action === "refresh") {
            await provider.fetchAndSendBackgroundJobs.call(state, "parent", "fresh")
            expect(requests).toHaveLength(2)
            expect(sent).toEqual([{ type: "backgroundJobsLoaded", sessionID: "parent", requestID: "fresh", jobs: [] }])
          }
        } finally {
          held.resolve(Response.json({}, { status: 503 }))
          await pending
          await server.stop(true)
        }
      })

for (const status of [200, 503])
  it(`actual SDK current-scope cancellation ${status} keeps its ordinary result path`, async () => {
    const sent: Reply[] = []
    const requests: string[] = []
    const jobs = [{ id: "worker", status: "cancelled" }]
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(request.method)
        return request.method === "POST"
          ? Response.json(status === 200 ? {} : { message: "Cancellation unavailable" }, { status })
          : Response.json(jobs)
      },
    })
    const state = {
      client: createKiloClient({ baseUrl: server.url.toString() }),
      connectionState: "connected" as const,
      connectionGeneration: 1,
      jobsBackoff: 0,
      jobReads: new Map<string, symbol>(),
      getWorkspaceDirectory: () => "C:/original",
      postMessage: (message: Reply) => sent.push(message),
      fetchAndSendBackgroundJobs: async (sessionID: string, requestID: string) =>
        provider.fetchAndSendBackgroundJobs.call(state, sessionID, requestID),
    }
    const provider = KiloProvider.prototype as unknown as {
      fetchAndSendBackgroundJobs: (this: typeof state, sessionID: string, requestID: string) => Promise<void>
      cancelBackgroundJob: (this: typeof state, jobID: string, sessionID: string, requestID: string) => Promise<void>
    }
    try {
      await provider.cancelBackgroundJob.call(state, "worker", "parent", "current")
      expect(requests).toEqual(status === 200 ? ["POST", "GET"] : ["POST"])
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ sessionID: "parent", requestID: "current", jobs: status === 200 ? jobs : [] })
      expect(!!sent[0].error).toBe(status !== 200)
      expect(state.jobsBackoff).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

for (const status of [200, 503])
  it(`actual SDK older same-session status ${status} cannot replace a newer success or its backoff`, async () => {
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<Response>()
    const sent: Reply[] = []
    const requests: string[] = []
    const jobs = [{ id: "worker", status: "completed" }]
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(request.method)
        if (requests.length > 1) return Response.json(jobs)
        entered.resolve()
        return held.promise
      },
    })
    const state = {
      client: createKiloClient({ baseUrl: server.url.toString() }),
      connectionState: "connected" as const,
      connectionGeneration: 1,
      jobsBackoff: 0,
      jobReads: new Map<string, symbol>(),
      getWorkspaceDirectory: () => "C:/original",
      postMessage: (message: Reply) => sent.push(message),
    }
    const provider = KiloProvider.prototype as unknown as {
      fetchAndSendBackgroundJobs: (this: typeof state, sessionID: string, requestID: string) => Promise<void>
    }
    const pending = provider.fetchAndSendBackgroundJobs.call(state, "parent", "old")
    try {
      await entered.promise
      await provider.fetchAndSendBackgroundJobs.call(state, "parent", "new")
      expect(sent).toEqual([{ type: "backgroundJobsLoaded", sessionID: "parent", requestID: "new", jobs }])
      held.resolve(Response.json(status === 200 ? [{ id: "worker", status: "running" }] : {}, { status }))
      await pending
      expect(sent).toHaveLength(1)
      expect(state.jobsBackoff).toBe(0)
      expect(state.jobReads.size).toBe(0)
      await provider.fetchAndSendBackgroundJobs.call(state, "parent", "fresh")
      expect(requests).toHaveLength(3)
      expect(sent[1]).toMatchObject({ requestID: "fresh", jobs })
    } finally {
      held.resolve(Response.json({}, { status: 503 }))
      await pending
      await server.stop(true)
    }
  })

it("actual SDK worker status reads for independent sessions both complete", async () => {
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<Response>()
  const sent: Reply[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).searchParams.get("sessionID") === "first") {
        entered.resolve()
        return held.promise
      }
      return Response.json([])
    },
  })
  const state = {
    client: createKiloClient({ baseUrl: server.url.toString() }),
    connectionState: "connected" as const,
    connectionGeneration: 1,
    jobsBackoff: 0,
    jobReads: new Map<string, symbol>(),
    getWorkspaceDirectory: () => "C:/original",
    postMessage: (message: Reply) => sent.push(message),
  }
  const provider = KiloProvider.prototype as unknown as {
    fetchAndSendBackgroundJobs: (this: typeof state, sessionID: string, requestID: string) => Promise<void>
  }
  const pending = provider.fetchAndSendBackgroundJobs.call(state, "first", "one")
  try {
    await entered.promise
    await provider.fetchAndSendBackgroundJobs.call(state, "second", "two")
    held.resolve(Response.json([]))
    await pending
    expect(sent.map((reply) => reply.sessionID)).toEqual(["second", "first"])
    expect(state.jobReads.size).toBe(0)
  } finally {
    held.resolve(Response.json({}, { status: 503 }))
    await pending
    await server.stop(true)
  }
})
