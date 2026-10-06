import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { DreamTransport } from "../../src/second-brain/dream-transport"
import type { CanvasConnection } from "../../src/services/canvas/canvas-bridge"

/** Actual SDK/HTTP with controlled receipts; not native inference or workspace consent evidence. */
function fixture() {
  const bodies: Record<string, unknown>[] = []
  const entered = Promise.withResolvers<void>()
  const inspected = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const state = { held: false, settled: false, inspections: 0 }
  const jobs = new Set<Promise<Response>>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const work = (async () => {
        const body: Record<string, unknown> = await request.json()
        if (new URL(request.url).pathname.endsWith("/generate")) {
          bodies.push(body)
          entered.resolve()
          if (state.held) await release.promise
          state.settled = true
          return Response.json({
            id: body.id,
            owner: body.owner,
            configuredModel: body.model,
            text: '{"items":[]}',
            settlement: "sdk",
          })
        }
        state.inspections++
        inspected.resolve()
        return Response.json({
          id: body.id,
          owner: body.owner,
          configuredModel: "fixture/model",
          settlement: state.settled ? "sdk" : "pending",
          outcome: state.settled ? "completed" : "running",
          startedAt: 1,
        })
      })()
      jobs.add(work)
      void work.then(
        () => jobs.delete(work),
        () => jobs.delete(work),
      )
      return work
    },
  })
  let client = createKiloClient({ baseUrl: server.url.toString() })
  const states = new Set<Parameters<CanvasConnection["onStateChange"]>[0]>()
  const connection: CanvasConnection = {
    getClient: () => client,
    getKnownDirectories: () => [],
    onEvent: () => () => undefined,
    onStateChange: (callback) => {
      states.add(callback)
      return () => {
        states.delete(callback)
      }
    },
  }
  return {
    bodies,
    entered,
    inspected,
    release,
    state,
    connection,
    replace(value: ReturnType<typeof createKiloClient>) {
      client = value
      for (const callback of states) callback("connected")
    },
    async close() {
      release.resolve()
      await Promise.allSettled([...jobs])
      await server.stop(true)
    },
  }
}

async function run(model: DreamTransport, signal?: AbortSignal) {
  const resolved = await Effect.runPromise(
    model.port.resolve({ configured: "fixture/model", session: { providerID: "fixture", modelID: "model" } }),
  )
  return model.port.run({
    handle: resolved.handle,
    system: "Synthetic instructions",
    prompt: "Synthetic approved input",
    budget: { input: 1000, output: 500 },
    timeoutMs: 5000,
    signal,
  })
}

test("native transport retains exact request metadata and joins one original SDK receipt", async () => {
  const cfg = fixture()
  const selected = {
    id: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    project: "C:/Synthetic",
    model: "fixture/model",
  }
  const original = { ...selected }
  const model = new DreamTransport(cfg.connection, selected)
  selected.id = crypto.randomUUID()
  try {
    expect(await run(model)).toEqual({ text: '{"items":[]}', usage: undefined })
    await model.close()
    await model.close()
    expect(cfg.bodies).toHaveLength(1)
    expect(cfg.bodies[0]).toMatchObject({
      id: original.id,
      owner: original.owner,
      model: original.model,
      budget: { input: 1000, output: 500 },
    })
    expect(cfg.state.inspections).toBe(1)
  } finally {
    await cfg.close()
  }
})

test("cancelled client transport waits for original backend SDK inspection without replay", async () => {
  const cfg = fixture()
  cfg.state.held = true
  const model = new DreamTransport(cfg.connection, {
    id: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    project: "C:/Synthetic",
    model: "fixture/model",
  })
  const controller = new AbortController()
  const result = run(model, controller.signal).then(
    () => "accepted",
    () => "cancelled",
  )
  try {
    await cfg.entered.promise
    controller.abort()
    expect(await result).toBe("cancelled")
    const closed = model.close()
    await cfg.inspected.promise
    expect(await Promise.race([closed.then(() => "closed"), Bun.sleep(10).then(() => "held")])).toBe("held")
    cfg.release.resolve()
    await closed
    expect(cfg.bodies).toHaveLength(1)
    expect(cfg.state.inspections).toBeGreaterThanOrEqual(2)
  } finally {
    cfg.release.resolve()
    await cfg.close()
  }
})

test("a replaced backend cannot receive retained generation or retirement inspection", async () => {
  const cfg = fixture()
  const next = fixture()
  cfg.state.held = true
  const model = new DreamTransport(cfg.connection, {
    id: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    project: "C:/Synthetic",
    model: "fixture/model",
  })
  const result = run(model).then(
    () => "accepted",
    () => "refused",
  )
  try {
    await cfg.entered.promise
    cfg.replace(next.connection.getClient())
    cfg.release.resolve()
    expect(await result).toBe("refused")
    const failure = await model.close().then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(next.bodies).toEqual([])
    expect(next.state.inspections).toBe(0)
    expect(cfg.state.inspections).toBe(0)
  } finally {
    cfg.release.resolve()
    await Promise.all([cfg.close(), next.close()])
  }
})
