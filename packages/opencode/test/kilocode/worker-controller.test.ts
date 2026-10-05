import { expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"
import { admission } from "../../src/kilocode/server/listener"
import { listener, quiesce, shutdown } from "../../src/kilocode/cli/cmd/tui/worker-shutdown"

async function tcp(body: Effect.Effect<HttpServerResponse.HttpServerResponse>) {
  const scope = Effect.runSync(Scope.make())
  const gate = admission()
  const layer = HttpRouter.serve(HttpRouter.add("GET", "/", body), {
    middleware: gate.middleware,
    disableLogger: true,
    disableListenLog: true,
  }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })))
  const ctx = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  const server = Context.get(ctx, HttpServer.HttpServer)
  if (server.address._tag !== "TcpAddress") throw new Error("missing TCP listener")
  let closed: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${server.address.port}`,
    quiesce: gate.quiesce,
    stop: () => (closed ??= Effect.runPromise(Scope.close(scope, Exit.void))),
  }
}

test("worker listener fences real TCP while joining an accepted request and exact listener scope", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = listener<Awaited<ReturnType<typeof tcp>>>()
  const server = await controller.open(() =>
    tcp(
      Effect.promise(async () => {
        started.resolve()
        await release.promise
        return HttpServerResponse.text("persisted")
      }),
    ),
  )
  try {
    const accepted = fetch(server.url)
    await started.promise
    const closed = controller.quiesce()
    expect(controller.quiesce()).toBe(closed)
    const late = await fetch(server.url)
    expect(late.status).toBe(503)
    expect(await late.text()).toBe("Server is shutting down")
    let settled = false
    void closed.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    const refused = await controller
      .open(() => tcp(Effect.succeed(HttpServerResponse.empty())))
      .catch((err: unknown) => err)
    expect(String(refused)).toContain("admission is closing")
    release.resolve()
    expect(await (await accepted).text()).toBe("persisted")
    await closed
    const stop = controller.stop()
    expect(controller.stop()).toBe(stop)
    await stop
    expect((await Promise.allSettled([fetch(server.url)]))[0].status).toBe("rejected")
  } finally {
    release.resolve()
    await controller.stop()
  }
})

test("a late realized listener is never published and its actual TCP scope closes before refusal", async () => {
  const built = Promise.withResolvers<Awaited<ReturnType<typeof tcp>>>()
  const release = Promise.withResolvers<void>()
  const controller = listener<Awaited<ReturnType<typeof tcp>>>()
  const opening = controller.open(async () => {
    const server = await tcp(Effect.succeed(HttpServerResponse.text("alive")))
    built.resolve(server)
    await release.promise
    return server
  })
  const refusal = opening.catch((err: unknown) => err)
  const server = await built.promise
  try {
    expect((await fetch(server.url)).status).toBe(200)
    const closed = controller.quiesce()
    const failure = closed.catch((err: unknown) => err)
    release.resolve()
    expect(String(await refusal)).toContain("completed after admission closed")
    const err = await failure
    expect(err).toBeInstanceOf(AggregateError)
    expect(await controller.quiesce().catch((err: unknown) => err)).toBe(err)
    expect((await Promise.allSettled([fetch(server.url)]))[0].status).toBe("rejected")
    expect(await controller.stop().catch((err: unknown) => err)).toBe(err)
  } finally {
    release.resolve()
    await Promise.allSettled([controller.stop()])
  }
})

test("worker cleanup joins held actual scopes, attempts later failed finalizers, and retains failures", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const first = Effect.runSync(Scope.make())
  const second = Effect.runSync(Scope.make())
  const third = Effect.runSync(Scope.make())
  let finalized = 0
  await Effect.runPromise(
    Scope.addFinalizer(
      first,
      Effect.promise(async () => {
        started.resolve()
        await release.promise
        throw new Error("held real scope failed")
      }),
    ),
  )
  await Effect.runPromise(Scope.addFinalizer(second, Effect.die(new Error("later real scope failed"))))
  await Effect.runPromise(
    Scope.addFinalizer(
      third,
      Effect.sync(() => {
        finalized += 1
      }),
    ),
  )
  const run = shutdown({
    drain: () => Effect.runPromise(Scope.close(first, Exit.void)),
    stopHeap: () => Effect.runPromise(Scope.close(second, Exit.void)),
    dispose: () => Effect.runPromise(Scope.close(third, Exit.void)),
    stopServer: () => Promise.resolve(),
  })
  const closed = run()
  const failure = closed.catch((err: unknown) => err)
  try {
    await started.promise
    expect(run()).toBe(closed)
    expect(finalized).toBe(0)
    release.resolve()
    const err = await failure
    expect(err).toBeInstanceOf(AggregateError)
    if (!(err instanceof AggregateError)) throw err
    expect(err.errors.map(String).join("\n")).toContain("held real scope failed")
    expect(err.errors.map(String).join("\n")).toContain("later real scope failed")
    expect(finalized).toBe(1)
    expect(run()).toBe(closed)
    expect(await run().catch((err: unknown) => err)).toBe(err)
  } finally {
    release.resolve()
    await Promise.allSettled([first, second, third].map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))))
  }
})

test("beginning fences all owners synchronously even when the first owner throws", async () => {
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(Scope.addFinalizer(scope, Effect.die(new Error("actual intake scope failed"))))
  let fenced = false
  const closed = quiesce([
    () => {
      throw new Error("first fence failed")
    },
    () => {
      fenced = true
      return Effect.runPromise(Scope.close(scope, Exit.void))
    },
  ])
  expect(fenced).toBe(true)
  const err = await closed.catch((err: unknown) => err)
  expect(err).toBeInstanceOf(AggregateError)
  if (!(err instanceof AggregateError)) throw err
  expect(err.errors.map(String).join("\n")).toContain("first fence failed")
  expect(err.errors.map(String).join("\n")).toContain("actual intake scope failed")
})
