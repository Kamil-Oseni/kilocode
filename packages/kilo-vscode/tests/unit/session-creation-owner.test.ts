import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import type { Session } from "@kilocode/sdk/v2/client"
import type { Followup } from "../../src/kilo-provider/followup-session"

const { KiloProvider } = await import("../../src/KiloProvider")

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

function host(values: Record<string, unknown>): unknown {
  return Object.create(
    KiloProvider.prototype,
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        { value, writable: true, configurable: true, enumerable: true },
      ]),
    ),
  )
}

async function bound<T>(job: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      job,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned loopback gate did not settle")), 3000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const scope of ["client-config", "client-session", "workspace", "project"]) {
  test(`retire delayed ${scope} creation without publishing or retiring the successor`, async () => {
    const phase = scope === "client-config" ? "config" : "session"
    const held = gate()
    const arrived = gate()
    const waiting = gate()
    const replacement = gate()
    const posts: unknown[] = []
    const deletes: string[] = []
    const creations: string[] = []
    const servers: Array<{ stop: (force?: boolean) => void | Promise<void> }> = []
    const jobs: Promise<unknown>[] = []
    const directory = process.cwd()
    let workspace = directory
    let project = "project"
    const session = (id: string) => ({
      id,
      version: "fixture",
      projectID: "project",
      directory,
      title: "Private loopback",
      time: { created: 1, updated: 1 },
    })
    const server = (name: string) => {
      let configs = 0
      const instance = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const route = new URL(request.url).pathname
          if (route === "/config") configs++
          const owner = name === "original" && configs > 1 ? "successor" : name
          if (request.method === "DELETE") {
            deletes.push(name)
            return Response.json(true)
          }
          if (route === "/session") creations.push(owner)
          if (owner === "original" && route === `/${phase}`) {
            arrived.open()
            await held.promise
          }
          if (route === "/config") return Response.json({ sandbox: { enabled: false } })
          expect(route).toBe("/session")
          expect(request.method).toBe("POST")
          if (owner === "successor") {
            replacement.open()
            await waiting.promise
          }
          return Response.json(session(owner))
        },
      })
      servers.push(instance)
      return instance
    }
    try {
      const original = server("original")
      const successor = server("successor")
      type State = {
        client: ReturnType<typeof createKiloClient>
        connectionGeneration: number
        connectionState: string
        currentSession?: Session
        contextSessionID?: string
        sessionCreations: Map<string, Promise<{ sid: string; dir: string } | undefined>>
        draftSessions: Map<string, { sid: string; dir: string; expires: number }>
        creatingDrafts: Set<string>
        closedDrafts: Set<string>
        resolveSession: (session?: string, draft?: string) => Promise<{ sid: string; dir: string } | undefined>
      }
      // Exercise the actual provider method; only VS Code publication adapters are replaced.
      const state = host({
        client: createKiloClient({ baseUrl: original.url.toString() }),
        connectionGeneration: 1,
        connectionState: "connected",
        opts: { projectQualifier: () => ({ projectId: project }) },
        connectionService: {},
        sessionCreations: new Map(),
        draftSessions: new Map(),
        creatingDrafts: new Set(),
        closedDrafts: new Set(),
        sessionDirectories: new Map(),
        trackedSessionIds: new Set(),
        getContextDirectory: () => workspace,
        getRootDirectory: () => workspace,
        stopCurrentSessionProcesses: () => {},
        setCurrentSession: (value: Session) => (state.currentSession = value),
        focusSession: () => {},
        trackDirectory: () => {},
        sessionToWebview: (value: Session) => value,
        postMessage: (value: unknown) => posts.push(value),
      }) as State
      const draft = "pending:loopback"
      const pending = state.resolveSession(undefined, draft)
      const refusal = pending.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      )
      jobs.push(refusal)
      await bound(arrived.promise)
      if (scope.startsWith("client")) {
        state.client = createKiloClient({ baseUrl: successor.url.toString() })
        state.connectionGeneration++
      }
      if (scope === "workspace") workspace = directory + "/successor"
      if (scope === "project") project = "successor"
      const fresh = state.resolveSession(undefined, draft).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      )
      jobs.push(fresh)
      await bound(replacement.promise)
      held.open()
      const retired = await bound(refusal)
      if (retired.status !== "rejected") throw new Error("Retired session creation unexpectedly succeeded")
      expect(retired.reason).toBeInstanceOf(Error)
      expect(String(retired.reason)).toContain("Session creation interrupted")
      expect(posts).toEqual([])
      expect(deletes).toEqual([])
      expect(state.draftSessions.size).toBe(0)
      expect(state.sessionCreations.size).toBe(1)
      expect(state.creatingDrafts.has(draft)).toBe(true)
      waiting.open()
      const result = await bound(fresh)
      if (result.status !== "fulfilled") throw result.reason
      expect(result.value).toEqual({ sid: "successor", dir: workspace })
      expect(state.currentSession?.id).toBe("successor")
      expect(posts).toHaveLength(1)
      expect(state.sessionCreations.size).toBe(0)
      expect(state.creatingDrafts.size).toBe(0)
      expect(creations).toEqual(phase === "config" ? ["successor"] : ["original", "successor"])
    } finally {
      held.open()
      waiting.open()
      await Promise.all(servers.map((server) => server.stop(true)))
      await bound(Promise.all(jobs))
    }
  }, 10_000)
}

for (const status of [200, 500]) {
  for (const replaced of [false, true]) {
    test(`held Ask reply ${status}, replaced=${replaced}, preserves the successor followup`, async () => {
      const held = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const requests: string[] = []
      const posts: unknown[] = []
      const routes = new Map([["original", process.cwd()]])
      const servers: Array<{ stop: (force?: boolean) => void | Promise<void> }> = []
      const jobs: Promise<unknown>[] = []
      try {
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            requests.push(new URL(request.url).pathname)
            expect(request.method).toBe("POST")
            expect(requests.at(-1)).toBe("/question/original/reply")
            started.resolve()
            await held.promise
            return Response.json(status === 200 ? true : { error: "Retained failure" }, { status })
          },
        })
        servers.push(server)
        type State = {
          connectionGeneration: number
          pendingFollowup: Followup | null
          replyQuestion: (message: { requestID: string; answers: string[][]; sessionID?: string }) => Promise<void>
          noteFollowup: (answers: string[][], session?: string) => void
        }
        // Invoke the provider's actual questionReply dispatch method and SDK handler.
        // Only publication and in-memory directory bookkeeping adapt the VS Code host.
        const state = host({
          client: createKiloClient({ baseUrl: server.url.toString() }),
          connectionState: "connected",
          connectionGeneration: 1,
          opts: { projectQualifier: () => ({ projectId: "project" }) },
          pendingFollowup: null,
          trackedSessionIds: new Set(),
          sessionDirectories: new Map(),
          getContextDirectory: () => process.cwd(),
          getWorkspaceDirectory: () => process.cwd(),
          postMessage: (message: unknown) => posts.push(message),
          connectionService: {
            recordQuestionDirectory: (id: string, directory: string) => routes.set(id, directory),
            getQuestionDirectory: (id: string) => routes.get(id),
            clearQuestionDirectory: (id: string) => routes.delete(id),
            getQuestionRevision: () => 0,
            pruneQuestionDirectories: () => {},
          },
        }) as State
        const pending = state.replyQuestion({ requestID: "original", answers: [["Start new session"]] }).then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        )
        jobs.push(pending)
        await bound(started.promise)
        const original = state.pendingFollowup
        expect(original).not.toBeNull()
        if (replaced) state.connectionGeneration++
        state.noteFollowup([["Start new session"]])
        const successor = state.pendingFollowup
        expect(successor).not.toBe(original)
        held.resolve()
        const result = await bound(pending)
        if (result.status !== "fulfilled") throw result.reason
        expect(state.pendingFollowup).toBe(successor)
        expect(requests).toHaveLength(1)
        if (replaced) {
          expect(posts).toEqual([])
          expect(routes.has("original")).toBe(true)
        }
      } finally {
        held.resolve()
        await Promise.all(servers.map((server) => server.stop(true)))
        await bound(Promise.all(jobs))
      }
    }, 10_000)
  }
}
