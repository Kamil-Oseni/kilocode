import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { RoutineEvents } from "../../src/kilo-provider/routine-events"
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
