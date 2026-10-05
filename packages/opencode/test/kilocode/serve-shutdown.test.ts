import { expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { EventEmitter } from "node:events"
import { createServer } from "node:http"
import { serveShutdown } from "../../src/kilocode/cli/serve-shutdown"
import { admission } from "../../src/kilocode/server/listener"
import { failure } from "../../src/kilocode/migration/source-failure"

test("overlapping signals join held cleanup and report failed finalizers after later cleanup", async () => {
  const signals = new EventEmitter()
  const scope = Scope.makeUnsafe()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  await Effect.runPromise(
    Scope.addFinalizer(
      scope,
      Effect.promise(async () => {
        started.resolve()
        await release.promise
        throw new Error("signal finalizer failed")
      }),
    ),
  )
  const shutdown = serveShutdown({
    signals,
    watchdog: () => {
      events.push("watchdog")
    },
    tasks: [
      () => Effect.runPromise(Scope.close(scope, Exit.void)),
      () => {
        events.push("instances")
      },
    ],
  })
  const observed = Promise.allSettled([shutdown.wait])
  signals.emit("SIGTERM")
  await started.promise
  signals.emit("SIGINT")
  signals.emit("SIGHUP")
  const first = shutdown.run()
  expect(shutdown.run()).toBe(first)
  expect(events).toEqual(["watchdog"])
  release.resolve()
  const results = await observed
  expect(events).toEqual(["watchdog", "instances"])
  expect(results[0].status).toBe("rejected")
  if (results[0].status === "rejected") {
    expect(results[0].reason.code).toBe("RAYA_SERVE_TASK_FAILED")
    expect(String(results[0].reason.cause)).toContain("signal finalizer failed")
  }
  expect((await Promise.allSettled([shutdown.run()]))[0]).toEqual(results[0])
  expect(signals.listenerCount("SIGTERM")).toBe(0)
  expect(signals.listenerCount("SIGINT")).toBe(0)
  expect(signals.listenerCount("SIGHUP")).toBe(0)
})

test("real TCP listener fences new dispatch and joins an accepted handler before drain", async () => {
  const signals = new EventEmitter()
  const scope = Scope.makeUnsafe()
  const gate = admission()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  const layer = HttpRouter.serve(
    HttpRouter.add(
      "GET",
      "/",
      Effect.promise(async () => {
        started.resolve()
        await release.promise
        return HttpServerResponse.text("accepted")
      }),
    ),
    { middleware: gate.middleware },
  ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })))
  const ctx = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  const server = Context.get(ctx, HttpServer.HttpServer)
  if (server.address._tag !== "TcpAddress") throw new Error("Missing real TCP listener")
  const url = `http://127.0.0.1:${server.address.port}`
  const held = fetch(url).then((response) => response.text())
  await started.promise
  const fenced = Promise.withResolvers<void>()
  const shutdown = serveShutdown({
    signals,
    watchdog: () => undefined,
    tasks: [
      () => {
        const pending = gate.quiesce()
        fenced.resolve()
        return pending
      },
      () => {
        events.push("drain")
      },
      () => Effect.runPromise(Scope.close(scope, Exit.void)),
    ],
  })
  signals.emit("SIGTERM")
  await fenced.promise
  expect((await fetch(url)).status).toBe(503)
  expect(events).toEqual([])
  signals.emit("SIGINT")
  release.resolve()
  expect(await held).toBe("accepted")
  await shutdown.wait
  expect(events).toEqual(["drain"])
  expect((await Promise.allSettled([fetch(url)]))[0].status).toBe("rejected")
})

test("a timed-out stage joins its actual work before later cleanup and remains refused", async () => {
  const signals = new EventEmitter()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  const shutdown = serveShutdown({
    signals,
    watchdog: () => undefined,
    timeout: 10,
    tasks: [
      () => release.promise,
      () => {
        events.push("later")
      },
    ],
  })
  const observed = Promise.allSettled([shutdown.wait])
  signals.emit("SIGINT")
  await Bun.sleep(30)
  expect(events).toEqual([])
  release.resolve()
  const results = await observed
  expect(results[0].status).toBe("rejected")
  if (results[0].status === "rejected") expect(String(results[0].reason)).toContain("stage 1 timed out")
  expect(events).toEqual(["later"])
  expect((await Promise.allSettled([shutdown.run()]))[0]).toEqual(results[0])
})

test("a failure after the deadline retains both refusals before dependent disposal", async () => {
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  const shutdown = serveShutdown({
    signals: new EventEmitter(),
    watchdog: () => undefined,
    timeout: 10,
    tasks: [
      async () => {
        await release.promise
        events.push("actual settled")
        throw new Error("native close failed")
      },
      () => {
        events.push("dependent disposal")
      },
    ],
  })
  const observed = Promise.allSettled([shutdown.wait])
  void shutdown.run()
  await Bun.sleep(30)
  expect(events).toEqual([])
  release.resolve()
  const [result] = await observed
  expect(events).toEqual(["actual settled", "dependent disposal"])
  expect(result.status).toBe("rejected")
  if (result.status !== "rejected") throw new Error("Expected retained cleanup failure")
  expect(result.reason).toBeInstanceOf(AggregateError)
  expect(result.reason.errors[0].code).toBe("RAYA_SERVE_TASK_TIMEOUT")
  expect(result.reason.errors[1].code).toBe("RAYA_SERVE_TASK_FAILED")
  expect(String(result.reason.errors[1].cause)).toBe("Error: native close failed")
  expect(
    failure(result.reason)
      .errors.filter((item) => item.code?.startsWith("RAYA_SERVE_"))
      .map((item) => ({ code: item.code, stage: item.stage })),
  ).toEqual([
    { code: "RAYA_SERVE_TASK_TIMEOUT", stage: 1 },
    { code: "RAYA_SERVE_TASK_FAILED", stage: 1 },
  ])
})

test("accepted scheduler work is joined before dependent cleanup even past stage deadline", async () => {
  const signals = new EventEmitter()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  const shutdown = serveShutdown({
    signals,
    watchdog: () => undefined,
    timeout: 10,
    admission: () => {
      entered.resolve()
      return release.promise
    },
    tasks: [
      () => {
        events.push("dependent disposal")
      },
    ],
  })
  signals.emit("SIGTERM")
  await entered.promise
  // Here elapsed time tests the actual cleanup deadline, not readiness synchronization.
  await Bun.sleep(30)
  expect(events).toEqual([])
  signals.emit("SIGINT")
  release.resolve()
  await shutdown.wait
  expect(events).toEqual(["dependent disposal"])
})

test("aborting an accepted real HTTP request releases admission and leaves later requests fenced", async () => {
  const scope = Scope.makeUnsafe()
  const gate = admission()
  const started = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  const controller = new AbortController()
  const layer = HttpRouter.serve(
    HttpRouter.add(
      "GET",
      "/",
      Effect.sync(started.resolve).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(stopped.resolve))),
    ),
    { middleware: gate.middleware, disableLogger: true, disableListenLog: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })))
  const ctx = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  const server = Context.get(ctx, HttpServer.HttpServer)
  if (server.address._tag !== "TcpAddress") throw new Error("Missing real TCP listener")
  const url = `http://127.0.0.1:${server.address.port}`
  try {
    const request = Promise.allSettled([fetch(url, { signal: controller.signal })])
    await started.promise
    const pending = gate.quiesce()
    expect(gate.quiesce()).toBe(pending)
    expect((await fetch(url)).status).toBe(503)
    controller.abort()
    expect((await request)[0].status).toBe("rejected")
    await stopped.promise
    await pending
    const refused = await fetch(url)
    expect(refused.status).toBe(503)
    expect(await refused.text()).toBe("Server is shutting down")
  } finally {
    controller.abort()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})
