import { expect, test } from "bun:test"
import { strict as assert } from "node:assert"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { retireHandler } from "@/kilocode/server/httpapi/retirement"

test("cached HTTP dispatch is fenced immediately while its real scope finalizer is pending", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  let finalizers = 0
  const routes = HttpRouter.use((router) =>
    router.add(
      "GET",
      "/",
      Effect.sync(() => {
        calls += 1
        return HttpServerResponse.text("ready")
      }),
    ),
  ).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.promise(async () => {
            finalizers += 1
            started.resolve()
            await release.promise
          }),
        ),
      ),
    ),
  )
  const app = retireHandler(HttpRouter.toWebHandler(routes, { disableLogger: true }))
  const dispatch = app.handler
  try {
    expect(await (await dispatch(new Request("http://localhost/"))).text()).toBe("ready")
    const closed = app.dispose()
    expect(app.dispose()).toBe(closed)
    await started.promise
    await assert.rejects(dispatch(new Request("http://localhost/")), /HTTP handler is retired/)
    expect(calls).toBe(1)
    expect(finalizers).toBe(1)
    release.resolve()
    await closed
    expect(app.dispose()).toBe(closed)
    await assert.rejects(dispatch(new Request("http://localhost/")), /HTTP handler is retired/)
    expect(calls).toBe(1)
  } finally {
    release.resolve()
    await app.dispose()
  }
})

test("a real HTTP scope finalizer failure stays rejected and cannot reopen dispatch", async () => {
  const routes = HttpRouter.use((router) =>
    router.add("GET", "/", Effect.succeed(HttpServerResponse.text("ready"))),
  ).pipe(
    Layer.provideMerge(Layer.effectDiscard(Effect.addFinalizer(() => Effect.die(new Error("HTTP finalizer failed"))))),
  )
  const app = retireHandler(HttpRouter.toWebHandler(routes, { disableLogger: true }))
  expect((await app.handler(new Request("http://localhost/"))).status).toBe(200)
  const closed = app.dispose()
  await assert.rejects(closed, /HTTP finalizer failed/)
  expect(app.dispose()).toBe(closed)
  await assert.rejects(app.handler(new Request("http://localhost/")), /HTTP handler is retired/)
})

test("retiring an unused HTTP handler does not build its service graph", async () => {
  let built = 0
  const routes = HttpRouter.use((router) =>
    router.add("GET", "/", Effect.succeed(HttpServerResponse.text("ready"))),
  ).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.sync(() => {
          built += 1
        }),
      ),
    ),
  )
  const app = retireHandler(HttpRouter.toWebHandler(routes, { disableLogger: true }))
  await app.dispose()
  await assert.rejects(app.handler(new Request("http://localhost/")), /HTTP handler is retired/)
  expect(built).toBe(0)
})
