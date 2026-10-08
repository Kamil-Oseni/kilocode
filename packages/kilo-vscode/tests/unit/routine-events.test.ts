import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { RoutineEvents } from "../../src/kilo-provider/routine-events"
import { RoutineRefresh } from "../../src/kilo-provider/routine-refresh"
import { projectRuns } from "../../webview-ui/src/components/routines/run-projection"

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function event(sequence: number, agentID = "worker") {
  return {
    version: 1,
    id: `${agentID}:${sequence}`,
    stream: agentID,
    sequence,
    kind: "run.changed",
    visibility: "workspace",
    runID: "run",
    agentID,
    sessionID: "session",
    stateRevision: sequence,
    status: sequence === 1 ? "running" : "complete",
    at: sequence,
  }
}

function page(cursor: number, agentID = "worker") {
  return {
    version: 1,
    cursor,
    runs: [
      {
        id: "run",
        agentID,
        sessionID: "session",
        at: 1,
        status: cursor === 1 ? "running" : "complete",
        revision: cursor,
      },
    ],
    events: [event(cursor, agentID)],
  }
}

test("terminal history limits retain older running and waiting identities", () => {
  const trace = {
    version: 1,
    goalCreatedAt: 1,
    turns: [
      {
        turnID: "msg_parent",
        messages: [{ messageID: "msg_assistant", actions: [{ actionID: "prt_action", status: "running" }] }],
      },
    ],
  }
  const pending = [
    { id: "running", revision: 3, status: "running" as const, trace },
    { id: "waiting", revision: 4, status: "blocked" as const, blockedReason: "waiting on you", trace },
  ]
  const terminal = Array.from({ length: 51 }, (_, index) => ({
    id: `terminal-${index}`,
    revision: 1,
    status: "complete" as const,
  }))
  const result = projectRuns([], [...pending, ...terminal], false)
  expect(result.find((run) => run.id === "running")).toEqual(pending[0])
  expect(result.find((run) => run.id === "waiting")).toEqual(pending[1])
  expect(result).toHaveLength(52)
  expect(result.some((run) => run.id === "terminal-0")).toBe(false)
  expect(result.some((run) => run.id === "terminal-50")).toBe(true)
})

test("out-of-order and duplicate hints replay once and a late bulk history cannot regress the run", async () => {
  const calls: string[] = []
  const messages: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      calls.push(url.searchParams.get("after") ?? "snapshot")
      expect(url.searchParams.get("directory")).toBe("workspace")
      return Response.json(page(3))
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const reader = new RoutineEvents(
    () => ({ client, directory: "workspace", generation: 1 }),
    (msg) => messages.push(msg),
  )
  try {
    await Promise.all([reader.hint(event(3)), reader.hint(event(2))])
    await reader.hint(event(2))
    expect(calls).toEqual(["snapshot"])
    const live = messages.find((msg) => msg.type === "routineRuns")!
    expect(live.cursor).toBe(3)
    const projected = projectRuns(live.runs as ReturnType<typeof page>["runs"], page(1).runs, true)
    expect(projected[0]?.status).toBe("complete")
    expect(projected[0]?.revision).toBe(3)
    expect(projectRuns([{ ...page(1).runs[0]!, id: "pruned" }], page(3).runs, false).map((run) => run.id)).toEqual([
      "run",
    ])
  } finally {
    reader.dispose()
    await server.stop(true)
  }
})

test("removing a watched worker cancels its in-flight history and refuses the late response", async () => {
  const entered = gate()
  const delayed = gate()
  const messages: Record<string, unknown>[] = []
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const id = new URL(request.url).pathname.split("/").at(-2)!
      calls.push(id)
      if (calls.length === 1) {
        entered.release()
        await delayed.promise
      }
      return Response.json(page(1))
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const reader = new RoutineEvents(
    () => ({ client, directory: "workspace", generation: 1 }),
    (msg) => messages.push(msg),
  )
  try {
    reader.watch(["worker"])
    const active = reader.hint(event(1))
    await entered.promise
    reader.watch([])
    reader.watch(["worker"])
    expect(await Promise.race([active.then(() => true), Bun.sleep(1000).then(() => false)])).toBe(true)
    delayed.release()
    await active
    expect(messages.filter((msg) => msg.type === "routineRuns")).toEqual([])
    await reader.hint(event(1))
    expect(calls).toHaveLength(2)
    expect(messages.filter((msg) => msg.type === "routineRuns").map((msg) => msg.cursor)).toEqual([1])
  } finally {
    delayed.release()
    reader.dispose()
    await server.stop(true)
  }
})

test("a late hint cannot restore a worker removed by the authoritative roster", async () => {
  const messages: Record<string, unknown>[] = []
  let calls = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      calls++
      return Response.json(page(1))
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const reader = new RoutineEvents(
    () => ({ client, directory: "workspace", generation: 1 }),
    (msg) => messages.push(msg),
  )
  try {
    reader.watch(["worker"])
    reader.watch([])
    await reader.hint(event(1))
    expect(calls).toBe(0)
    expect(messages).toEqual([])
  } finally {
    reader.dispose()
    await server.stop(true)
  }
})

test("unknown hint bursts share one authoritative refresh and a genuinely new worker becomes live", async () => {
  const entered = gate()
  const blocked = gate()
  const messages: Record<string, unknown>[] = []
  let listed = false
  let rosters = 0
  let histories = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const route = new URL(request.url).pathname
      if (route.endsWith("/agent")) {
        rosters++
        if (rosters === 1) {
          entered.release()
          await blocked.promise
        }
        return Response.json(listed ? [{ id: "worker" }] : [])
      }
      if (route.endsWith("/organization")) return Response.json({ items: [] })
      if (route.endsWith("/agent-runs"))
        return Response.json({ items: listed ? [{ agentID: "worker", runs: page(2).runs }] : [], failed: [] })
      if (route.endsWith("/events")) {
        histories++
        return Response.json(page(2))
      }
      return Response.json([])
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const scope = () => ({ client, directory: "workspace", generation: 1 })
  const refresh = new RoutineRefresh(scope, (msg) => {
    if (Array.isArray(msg.agents)) reader.watch(msg.agents.map((agent) => agent.id))
    messages.push(msg)
  })
  const reader = new RoutineEvents(
    scope,
    (msg) => messages.push(msg),
    15_000,
    () => refresh.request(),
  )
  try {
    reader.watch([])
    const burst = Promise.all(Array.from({ length: 64 }, () => reader.hint(event(1))))
    await entered.promise
    expect(rosters).toBe(1)
    expect(histories).toBe(0)
    blocked.release()
    await burst
    expect(rosters).toBe(1)
    expect(messages.filter((msg) => msg.type === "routineRuns")).toEqual([])
    listed = true
    await reader.hint(event(2))
    expect(rosters).toBe(2)
    expect(messages.some((msg) => msg.type === "routineRuns" && msg.agentID === "worker")).toBe(true)
    await reader.hint(event(2))
    expect(histories).toBe(1)
    expect(messages.some((msg) => msg.type === "routineRuns" && msg.cursor === 2)).toBe(true)
  } finally {
    blocked.release()
    reader.dispose()
    refresh.dispose()
    await server.stop(true)
  }
})

test("expired replay cursor falls back to a snapshot on reconnect", async () => {
  const calls: string[] = []
  const messages: Record<string, unknown>[] = []
  let cursor = 1
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const after = new URL(request.url).searchParams.get("after")
      calls.push(after ?? "snapshot")
      if (after === "1") return Response.json({ message: "Routine event cursor expired" }, { status: 400 })
      return Response.json(page(cursor))
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const reader = new RoutineEvents(
    () => ({ client, directory: "workspace", generation: 1 }),
    (msg) => messages.push(msg),
  )
  try {
    await reader.hint(event(1))
    cursor = 3
    await reader.recover()
    expect(calls).toEqual(["snapshot", "1", "snapshot"])
    expect(messages.filter((msg) => msg.type === "routineRuns").map((msg) => msg.cursor)).toEqual([1, 3])
  } finally {
    reader.dispose()
    await server.stop(true)
  }
})

test("a sequence gap replays from the last cursor and malformed hints do no work", async () => {
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const after = new URL(request.url).searchParams.get("after")
      calls.push(after ?? "snapshot")
      return Response.json(page(after ? 3 : 1))
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const reader = new RoutineEvents(
    () => ({ client, directory: "workspace", generation: 1 }),
    () => undefined,
  )
  try {
    await reader.hint({ ...event(1), id: "wrong" })
    await reader.hint({ ...event(1), at: Number.NaN })
    expect(calls).toEqual([])
    await reader.hint(event(1))
    await reader.hint(event(3))
    await reader.hint(event(2))
    expect(calls).toEqual(["snapshot", "1"])
  } finally {
    reader.dispose()
    await server.stop(true)
  }
})

for (const change of ["generation", "directory"] as const)
  test(`${change} change cancels a stalled response and admits the new scope immediately`, async () => {
    const started = gate()
    const blocked = gate()
    const messages: Record<string, unknown>[] = []
    let generation = 1
    let directory = "workspace"
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (
          new URL(request.url).searchParams.get("after") === null &&
          new URL(request.url).searchParams.get("directory") === "workspace" &&
          (change === "directory" || generation === 1)
        ) {
          started.release()
          await blocked.promise
          return Response.json(page(1))
        }
        return Response.json(page(2))
      },
    })
    const client = createKiloClient({ baseUrl: server.url.toString() })
    const reader = new RoutineEvents(
      () => ({ client, directory, generation }),
      (msg) => messages.push(msg),
    )
    try {
      const old = reader.hint(event(1))
      await started.promise
      if (change === "generation") generation = 2
      if (change === "directory") directory = "other"
      reader.invalidate()
      await reader.hint(event(2))
      blocked.release()
      await old
      expect(messages.filter((msg) => msg.type === "routineRuns").map((msg) => msg.cursor)).toEqual([2])
    } finally {
      blocked.release()
      reader.dispose()
      await server.stop(true)
    }
  })

test("live hint admission is bounded and reports overflow once", async () => {
  const messages: Record<string, unknown>[] = []
  const reader = new RoutineEvents(
    () => ({ client: null, directory: "workspace", generation: 1 }),
    (msg) => messages.push(msg),
  )
  try {
    reader.watch(Array.from({ length: 256 }, (_, index) => `worker-${index}`))
    for (let index = 0; index < 500; index++) await reader.hint(event(1, `foreign-${index}`))
    expect(messages.filter((msg) => msg.type === "routineState" && msg.error)).toHaveLength(1)
    expect(messages.filter((msg) => msg.type === "routineRuns")).toHaveLength(0)
  } finally {
    reader.dispose()
  }
})

test("unavailable-service recovery has a bounded deadline and four concurrent requests", async () => {
  const blocked = gate()
  const messages: Record<string, unknown>[] = []
  let active = 0
  let maximum = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      active++
      maximum = Math.max(maximum, active)
      try {
        await blocked.promise
        return Response.json(page(1))
      } finally {
        active--
      }
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const reader = new RoutineEvents(
    () => ({ client, directory: "workspace", generation: 1 }),
    (msg) => messages.push(msg),
    80,
  )
  try {
    reader.watch(Array.from({ length: 20 }, (_, index) => `worker-${index}`))
    await reader.recover()
    expect(maximum).toBeLessThanOrEqual(4)
    expect(messages.some((msg) => msg.type === "routineState" && String(msg.error).includes("timed out"))).toBe(true)
  } finally {
    blocked.release()
    reader.dispose()
    await server.stop(true)
  }
})

test("a failed recovery reports once and a later hint retries the durable snapshot", async () => {
  const messages: Record<string, unknown>[] = []
  let ready = false
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return ready ? Response.json(page(2)) : Response.json({ message: "Unavailable" }, { status: 503 })
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const reader = new RoutineEvents(
    () => ({ client, directory: "workspace", generation: 1 }),
    (msg) => messages.push(msg),
  )
  try {
    reader.watch(["worker"])
    await reader.recover()
    expect(messages.filter((msg) => String(msg.error).includes("could not be recovered"))).toHaveLength(1)
    ready = true
    await reader.hint(event(2))
    expect(messages.filter((msg) => msg.type === "routineRuns" && msg.cursor === 2)).toHaveLength(1)
  } finally {
    reader.dispose()
    await server.stop(true)
  }
})
