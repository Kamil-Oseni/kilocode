import { describe, expect, it } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"

const { KiloProvider } = await import("../../src/KiloProvider")

type Reply = { type: string; sessionID: string; requestID: string; jobs: unknown[]; error?: string }
type Stop = {
  client: ReturnType<typeof createKiloClient>
  generation: number
  directory: string
  jobID: string
  revision: string
  done: Promise<{ response: Response; error?: unknown }>
}
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
          jobStops: new Map<string, Stop>(),
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
            revision: string,
          ) => Promise<void>
        }
        const pending =
          action === "refresh"
            ? provider.fetchAndSendBackgroundJobs.call(state, "parent", "old")
            : provider.cancelBackgroundJob.call(state, "worker", "parent", "old", "shown-revision")
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
      jobStops: new Map<string, Stop>(),
      getWorkspaceDirectory: () => "C:/original",
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
        revision: string,
      ) => Promise<void>
    }
    try {
      await provider.cancelBackgroundJob.call(state, "worker", "parent", "current", "shown-revision")
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

for (const status of [200, 503])
  for (const replaced of [false, true])
    it(`actual SDK pending worker cancellation ${status} ${replaced ? "keeps replacement scope independent" : "shares its original request"}`, async () => {
      const entered = Promise.withResolvers<void>()
      const held = Promise.withResolvers<Response>()
      const requests: string[] = []
      const sent: Reply[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(request.method)
          if (request.method === "GET") return Response.json([])
          entered.resolve()
          return held.promise.then((response) => response.clone())
        },
      })
      const state = {
        client: createKiloClient({ baseUrl: server.url.toString() }),
        connectionState: "connected" as const,
        connectionGeneration: 1,
        jobsBackoff: 0,
        jobReads: new Map<string, symbol>(),
        jobStops: new Map<string, Stop>(),
        getWorkspaceDirectory: () => "C:/original",
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
          revision: string,
        ) => Promise<void>
      }
      const pending = provider.cancelBackgroundJob.call(state, "worker", "parent", "original", "shown-revision")
      let duplicate: Promise<void> | undefined
      try {
        await entered.promise
        if (replaced) state.connectionGeneration++
        duplicate = provider.cancelBackgroundJob.call(state, "worker", "parent", "duplicate", "shown-revision")
        // A GET barrier observes all HTTP requests dispatched before it without releasing the held cancellation.
        await state.client.kilocode.backgroundJobs({ directory: "C:/original", sessionID: "barrier" })
        expect(requests.filter((method) => method === "POST")).toHaveLength(replaced ? 2 : 1)
        expect(state.jobStops.size).toBe(replaced ? 2 : 1)
        held.resolve(Response.json(status === 200 ? true : { message: "Cancellation unavailable" }, { status }))
        await Promise.all([pending, duplicate])
        expect(state.jobStops.size).toBe(0)
        expect(requests.filter((method) => method === "POST")).toHaveLength(replaced ? 2 : 1)
        if (replaced) expect(sent).toHaveLength(1)
        expect(sent.some((reply) => reply.requestID === "duplicate" && !!reply.error === (status !== 200))).toBe(true)
      } finally {
        held.resolve(Response.json({}, { status: 503 }))
        await Promise.all([pending, duplicate])
        await server.stop(true)
      }
    })

for (const conflict of ["http", "pending"] as const)
  it(`refreshes a revision conflict (${conflict}) without cancelling the newer invocation`, async () => {
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<Response>()
    const bodies: unknown[] = []
    const sent: Reply[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET") return Response.json([{ id: "worker", revision: "newer", status: "running" }])
        const text = await request.text()
        bodies.push(text ? JSON.parse(text) : undefined)
        entered.resolve()
        return conflict === "http" ? Response.json({ message: "Revision conflict" }, { status: 409 }) : held.promise
      },
    })
    const state = {
      client: createKiloClient({ baseUrl: server.url.toString() }),
      connectionState: "connected" as const,
      connectionGeneration: 1,
      jobsBackoff: 0,
      jobReads: new Map<string, symbol>(),
      jobStops: new Map<string, Stop>(),
      getWorkspaceDirectory: () => "C:/original",
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
        revision: string,
      ) => Promise<void>
    }
    const pending = provider.cancelBackgroundJob.call(state, "worker", "parent", "stop", "displayed")
    try {
      await entered.promise
      if (conflict === "pending") {
        await provider.cancelBackgroundJob.call(state, "worker", "parent", "new-click", "newer")
        expect(state.jobStops.size).toBe(1)
        held.resolve(Response.json(false))
      }
      await pending
      expect(bodies).toEqual([{ revision: "displayed" }])
      expect(
        sent.some((message) => message.jobs.some((job) => (job as { revision?: string }).revision === "newer")),
      ).toBe(true)
      expect(state.jobStops.size).toBe(0)
    } finally {
      held.resolve(Response.json(false))
      await pending
      await server.stop(true)
    }
  })

for (const kind of ["directory", "client", "generation"] as const)
  it(`keeps the same job ID independent in two ${kind} contexts with captured revisions`, async () => {
    const entered = Promise.withResolvers<void>()
    const next = Promise.withResolvers<void>()
    const first = Promise.withResolvers<Response>()
    const second = Promise.withResolvers<Response>()
    const posts: { directory: string | null; body: unknown }[] = []
    const sent: Reply[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET") return Response.json([])
        posts.push({ directory: new URL(request.url).searchParams.get("directory"), body: await request.json() })
        if (posts.length === 1) entered.resolve()
        if (posts.length === 2) next.resolve()
        return posts.length === 1 ? first.promise : second.promise
      },
    })
    const workspace = { directory: "C:/first" }
    const state = {
      client: createKiloClient({ baseUrl: server.url.toString() }),
      connectionState: "connected" as const,
      connectionGeneration: 1,
      jobsBackoff: 0,
      jobReads: new Map<string, symbol>(),
      jobStops: new Map<string, Stop>(),
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
        revision: string,
      ) => Promise<void>
    }
    const original = provider.cancelBackgroundJob.call(state, "worker", "parent", "old", "first-revision")
    let pending: Promise<void> | undefined
    let finished = false
    try {
      await entered.promise
      if (kind === "directory") workspace.directory = "C:/second"
      if (kind === "client") state.client = createKiloClient({ baseUrl: server.url.toString() })
      if (kind === "generation") state.connectionGeneration++
      pending = provider.cancelBackgroundJob.call(state, "worker", "parent", "new", "second-revision")
      void pending.then(() => {
        finished = true
      })
      const timeout = setTimeout(() => next.reject(new Error("Second Stop request did not reach the server")), 3000)
      try {
        await next.promise
      } finally {
        clearTimeout(timeout)
      }
      expect(posts).toEqual([
        { directory: "C:/first", body: { revision: "first-revision" } },
        { directory: workspace.directory, body: { revision: "second-revision" } },
      ])
      expect(finished).toBe(false)
      expect(state.jobStops.size).toBe(2)
      second.resolve(Response.json(true))
      await pending
      expect(state.jobStops.size).toBe(1)
      expect(sent.map((message) => message.requestID)).toEqual(["new"])
      first.resolve(Response.json(true))
      await original
      expect(sent.map((message) => message.requestID)).toEqual(["new"])
      expect(state.jobStops.size).toBe(0)
    } finally {
      first.resolve(Response.json(false))
      second.resolve(Response.json(false))
      await Promise.all([original, pending])
      await server.stop(true)
    }
  })
