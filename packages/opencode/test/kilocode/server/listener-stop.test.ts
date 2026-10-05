import { expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"
import { stop } from "../../../src/kilocode/server/listener"
import { testEffect } from "../../lib/effect"

const it = testEffect(Layer.empty)

it.live("stop completes every cleanup and retains all failures for repeated callers", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const events: string[] = []
    const broken = (name: string) =>
      Effect.sync(() => events.push(name)).pipe(Effect.andThen(Effect.die(new Error(name))))
    yield* Scope.addFinalizer(scope, broken("scope"))
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        events.push("finalizer")
      }),
    )
    const shutdown = yield* stop({
      scope,
      unpublish: broken("mdns"),
      force: [broken("http"), broken("websocket")],
      pty: broken("pty"),
      clear: Effect.sync(() => {
        events.push("clear")
      }),
    })
    const first = yield* Effect.exit(shutdown(true))
    const second = yield* Effect.exit(shutdown())
    const third = yield* Effect.exit(shutdown(true))
    expect(Exit.isFailure(first)).toBe(true)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    if (Exit.isFailure(first)) {
      const errors = Cause.prettyErrors(first.cause)
        .map((error) => error.message)
        .sort()
      expect(errors).toEqual(["http", "mdns", "pty", "scope", "websocket"])
    }
    expect(events.filter((event) => event === "finalizer")).toHaveLength(1)
    expect(events).toHaveLength(7)
    expect(events.at(-1)).toBe("clear")
  }),
)

it.live("concurrent graceful and forced stop join the same held finalizer", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const started = yield* Deferred.make<void>()
    const forced = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const events: string[] = []
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        events.push("scope")
      }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Deferred.await(release))),
    )
    const shutdown = yield* stop({
      scope,
      unpublish: Effect.sync(() => {
        events.push("mdns")
      }),
      force: [
        Effect.sync(() => {
          events.push("force")
        }),
      ],
      pty: Effect.sync(() => {
        events.push("pty")
      }).pipe(Effect.andThen(Deferred.succeed(forced, undefined))),
      clear: Effect.sync(() => {
        events.push("clear")
      }),
    })
    const first = yield* shutdown().pipe(Effect.forkChild)
    yield* Deferred.await(started)
    const second = yield* shutdown(true).pipe(Effect.forkChild)
    yield* Deferred.await(forced)
    expect(events).not.toContain("clear")
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    yield* shutdown(true)
    expect(events.filter((event) => event === "scope")).toHaveLength(1)
    expect(events.filter((event) => event === "clear")).toHaveLength(1)
    expect(events.filter((event) => event === "mdns")).toHaveLength(1)
    expect(events.filter((event) => event === "force")).toHaveLength(1)
    expect(events.filter((event) => event === "pty")).toHaveLength(1)
  }),
)

it.live("a failing real listener finalizer rejects shutdown after closing its TCP listener", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const layer = HttpRouter.serve(HttpRouter.add("GET", "/", HttpServerResponse.text("alive"))).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    )
    const ctx = yield* Layer.buildWithScope(layer, scope)
    const server = Context.get(ctx, HttpServer.HttpServer)
    expect(server.address._tag).toBe("TcpAddress")
    if (server.address._tag !== "TcpAddress") throw new Error("missing TCP listener")
    const url = `http://127.0.0.1:${server.address.port}`
    const response = yield* Effect.promise(() => fetch(url))
    expect(yield* Effect.promise(() => response.text())).toBe("alive")
    yield* Scope.addFinalizer(scope, Effect.die(new Error("real listener finalizer failed")))
    const shutdown = yield* stop({
      scope,
      unpublish: Effect.void,
      force: [],
      pty: Effect.void,
      clear: Effect.void,
    })
    const results = yield* Effect.promise(() =>
      Promise.allSettled([Effect.runPromise(shutdown(true)), Effect.runPromise(shutdown(true))]),
    )
    for (const result of results) {
      expect(result.status).toBe("rejected")
      if (result.status === "rejected") expect(String(result.reason)).toContain("real listener finalizer failed")
    }
    const connection = yield* Effect.promise(() => Promise.allSettled([fetch(url)]))
    expect(connection[0].status).toBe("rejected")
  }),
)
