import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { RoutineRefresh } from "../../src/kilo-provider/routine-refresh"
import { handleRoutineMessage } from "../../src/kilo-provider/routines"

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test("a mutation during an active read is acknowledged once and requests one trailing read", async () => {
  const blocked = gate()
  const started = gate()
  const patched = gate()
  const acknowledged = gate()
  const messages: Record<string, unknown>[] = []
  let mutations = 0
  let cycles = 0
  let reads = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method === "PATCH") {
        mutations++
        patched.release()
        return Response.json({ id: "routine" })
      }
      reads++
      if (new URL(request.url).pathname.endsWith("/agent")) {
        cycles++
        if (cycles === 1) {
          started.release()
          await blocked.promise
        }
        return Response.json([{ id: "routine" }])
      }
      return Response.json([])
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const refresh = new RoutineRefresh(
    () => ({ client, directory: "workspace", generation: 1 }),
    (msg) => messages.push(msg),
  )
  try {
    const pending = refresh.request("view", "view")
    await started.promise
    const mutation = handleRoutineMessage({
      client,
      directory: "workspace",
      message: { type: "routineUpdate", agentID: "routine", enabled: false },
      post: (msg) => {
        messages.push(msg as Record<string, unknown>)
        if (typeof msg === "object" && msg !== null && "saved" in msg && msg.saved) acknowledged.release()
      },
      refresh: (id, view) => refresh.request(id, view),
    })
    await patched.promise
    // Wait for the actual SDK response and mutation acknowledgment before releasing the roster.
    await acknowledged.promise
    expect(messages.filter((msg) => msg.saved)).toHaveLength(1)
    blocked.release()
    await Promise.all([pending, mutation])
    expect(mutations).toBe(1)
    expect(cycles).toBe(2)
    expect(reads).toBe(8)
    expect(messages.filter((msg) => msg.refresh === "complete")).toHaveLength(2)
  } finally {
    blocked.release()
    refresh.dispose()
    await server.stop(true)
  }
})

test("real SDK HTTP refresh burst is bounded, partial histories remain explicit, and mutations are not replayed", async () => {
  const started = gate()
  const blocked = gate()
  const calls: string[] = []
  const messages: Record<string, unknown>[] = []
  let active = 0
  let maximum = 0
  let cycle = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      calls.push(`${request.method} ${url.pathname}`)
      expect(url.searchParams.get("directory")).toBe("workspace")
      active++
      maximum = Math.max(maximum, active)
      try {
        if (request.method === "PATCH") return Response.json({ id: "agent-0" })
        if (url.pathname.endsWith("/agent")) {
          cycle++
          if (cycle === 1) {
            started.release()
            await blocked.promise
          }
          return Response.json(Array.from({ length: 40 }, (_, i) => ({ id: `agent-${i}` })))
        }
        if (url.pathname.endsWith("/agent-templates")) return Response.json([])
        if (url.pathname.endsWith("/agent-inbox")) return Response.json([])
        const id = url.pathname.split("/").at(-2)!
        if (cycle === 2 && id === "agent-7") return new Response("unavailable", { status: 503 })
        return Response.json([{ id: `run-${id}`, agentID: id, status: "complete", at: cycle }])
      } finally {
        active--
      }
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const refresh = new RoutineRefresh(
    () => ({ client, directory: "workspace", generation: 1 }),
    (msg) => messages.push(msg),
  )
  try {
    const first = refresh.request("view", "view")
    await started.promise
    const requests = Array.from({ length: 100 }, () => refresh.request("view", "view"))
    const comparison = refresh.request("comparison")
    blocked.release()
    await Promise.all([first, ...requests, comparison])
    expect(calls).toHaveLength(86)
    expect(maximum).toBeLessThanOrEqual(2)
    expect(cycle).toBe(2)
    expect(messages.filter((msg) => msg.requestID === "view" && msg.refresh === "partial")).toHaveLength(1)
    expect(messages.some((msg) => msg.requestID === "comparison" && Array.isArray(msg.agents))).toBe(true)
    const history = messages.filter((msg) => msg.requestID === "view" && msg.agentID === "agent-7")
    expect(history).toHaveLength(2)
    expect(history[0].runs).toBeArray()
    expect(history[1].error).toBeString()
    expect(history[1].runs).toBeUndefined()
    expect(messages.some((msg) => msg.refreshID === 2 && msg.agentID === "agent-39" && Array.isArray(msg.runs))).toBe(
      true,
    )
    await handleRoutineMessage({
      client,
      directory: "workspace",
      post: (msg) => messages.push(msg as Record<string, unknown>),
      refresh: (id, view) => refresh.request(id, view),
      message: { type: "routineUpdate", agentID: "agent-0", enabled: false },
    })
    expect(calls.filter((call) => call.startsWith("PATCH"))).toHaveLength(1)
    expect(calls).toHaveLength(130)
    const saved = messages.findIndex((msg) => msg.saved === true)
    const loading = messages.findIndex((msg) => msg.refreshID === 3 && msg.refresh === "loading")
    expect(saved).toBeGreaterThan(-1)
    expect(saved).toBeLessThan(loading)
  } finally {
    blocked.release()
    refresh.dispose()
    await server.stop(true)
  }
}, 30_000)

for (const change of ["client", "directory", "generation"] as const)
  test(`${change} replacement fences obsolete replies`, async () => {
    const blocked = gate()
    const started = gate()
    const calls: string[] = []
    const messages: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url)
        const directory = url.searchParams.get("directory")!
        calls.push(`${directory}:${url.pathname}`)
        if (directory === "old" && url.pathname.endsWith("/agent")) {
          started.release()
          await blocked.promise
        }
        return Response.json([])
      },
    })
    const scope = { client: createKiloClient({ baseUrl: server.url.toString() }), directory: "old", generation: 1 }
    const refresh = new RoutineRefresh(
      () => scope,
      (msg) => messages.push(msg),
      80,
    )
    try {
      const old = refresh.request("old", "old")
      await started.promise
      if (change === "client") scope.client = createKiloClient({ baseUrl: server.url.toString() })
      if (change === "directory") scope.directory = "new"
      if (change === "generation") scope.generation++
      const current = refresh.request("new", "new")
      blocked.release()
      await Promise.all([old, current])
      expect(messages.filter((msg) => msg.requestID === "old")).toEqual([
        { type: "routineState", refresh: "loading", refreshID: 1, requestID: "old", viewID: "old" },
      ])
      expect(messages.some((msg) => msg.requestID === "new" && msg.refresh === "complete")).toBe(true)
      expect(calls.filter((call) => call.endsWith("/runs"))).toHaveLength(0)
      refresh.dispose()
      const count = calls.length
      await refresh.request("disposed")
      expect(calls).toHaveLength(count)
    } finally {
      blocked.release()
      refresh.dispose()
      await server.stop(true)
    }
  })

test("a stalled real HTTP refresh ends with explicit failure and allows retry", async () => {
  const blocked = gate()
  let stall = true
  const messages: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      if (stall) await blocked.promise
      return Response.json([])
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const refresh = new RoutineRefresh(
    () => ({ client, directory: "workspace", generation: 1 }),
    (msg) => messages.push(msg),
    30,
  )
  try {
    await refresh.request("view", "view")
    expect(messages.at(-1)?.refresh).toBe("error")
    stall = false
    blocked.release()
    await refresh.request("view", "view")
    expect(messages.at(-1)?.refresh).toBe("complete")
  } finally {
    blocked.release()
    refresh.dispose()
    await server.stop(true)
  }
})
