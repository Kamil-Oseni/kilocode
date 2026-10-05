import { expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { EventEmitter } from "node:events"
import { createServer } from "node:http"
import { admission } from "../../../src/kilocode/server/listener"
import { serveShutdown } from "../../../src/kilocode/cli/serve-shutdown"

test("ordinary shutdown joins accepted commands before disposal closes the original live SSE", async () => {
  const scope = Scope.makeUnsafe()
  const gate = admission()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const disposed = Promise.withResolvers<void>()
  const ended = Promise.withResolvers<void>()
  const fenced = Promise.withResolvers<void>()
  const events: string[] = []
  const layer = HttpRouter.serve(
    Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/event",
        Effect.succeed(
          HttpServerResponse.stream(
            Stream.make(new TextEncoder().encode("data: connected\n\n")).pipe(
              Stream.concat(
                Stream.fromEffect(Effect.promise(() => disposed.promise)).pipe(
                  Stream.map(() => new TextEncoder().encode("data: disposed\n\n")),
                ),
              ),
              Stream.ensuring(Effect.sync(ended.resolve)),
            ),
            { contentType: "text/event-stream" },
          ),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/command",
        Effect.promise(async () => {
          started.resolve()
          await release.promise
          events.push("command")
          return HttpServerResponse.text("accepted")
        }),
      ),
    ),
    { middleware: gate.middleware, disableLogger: true, disableListenLog: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })))
  const ctx = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  const server = Context.get(ctx, HttpServer.HttpServer)
  if (server.address._tag !== "TcpAddress") throw new Error("Missing real TCP listener")
  const url = `http://127.0.0.1:${server.address.port}`
  try {
    const response = await fetch(`${url}/event`)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: connected\n\n")
    const command = fetch(`${url}/command`, { method: "POST" }).then((value) => value.text())
    await started.promise
    const shutdown = serveShutdown({
      signals: new EventEmitter(),
      watchdog: () => undefined,
      admission: () => {
        const pending = gate.quiesce()
        fenced.resolve()
        return pending
      },
      tasks: [
        () => {
          events.push("dispose")
          disposed.resolve()
        },
        async () => {
          await ended.promise
          await Effect.runPromise(Scope.close(scope, Exit.void))
          events.push("closed")
        },
      ],
    })
    const closing = shutdown.run()
    await fenced.promise
    expect((await fetch(`${url}/command`, { method: "POST" })).status).toBe(503)
    expect(events).toEqual([])
    release.resolve()
    expect(await command).toBe("accepted")
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: disposed\n\n")
    expect((await reader.read()).done).toBe(true)
    await closing
    await shutdown.wait
    expect(events).toEqual(["command", "dispose", "closed"])
    expect((await Promise.allSettled([fetch(`${url}/event`)]))[0].status).toBe("rejected")
  } finally {
    release.resolve()
    disposed.resolve()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}, 15_000)

test("a failed accepted handler releases its ticket without releasing a concurrent held command", async () => {
  const scope = Scope.makeUnsafe()
  const gate = admission()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const layer = HttpRouter.serve(
    Layer.mergeAll(
      HttpRouter.add("GET", "/fail", Effect.die(new Error("synthetic handler failure"))),
      HttpRouter.add(
        "GET",
        "/held",
        Effect.promise(async () => {
          started.resolve()
          await release.promise
          return HttpServerResponse.text("accepted")
        }),
      ),
    ),
    { middleware: gate.middleware, disableLogger: true, disableListenLog: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })))
  const ctx = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  const server = Context.get(ctx, HttpServer.HttpServer)
  if (server.address._tag !== "TcpAddress") throw new Error("Missing real TCP listener")
  const url = `http://127.0.0.1:${server.address.port}`
  try {
    const command = fetch(`${url}/held`).then((response) => response.text())
    await started.promise
    const failed = await fetch(`${url}/fail`)
    expect(failed.status).toBe(500)
    await failed.text()
    const state = { joined: false }
    const pending = gate.quiesce().then(() => {
      state.joined = true
    })
    expect((await fetch(`${url}/held`)).status).toBe(503)
    expect(state.joined).toBe(false)
    release.resolve()
    expect(await command).toBe("accepted")
    await pending
    expect(state.joined).toBe(true)
  } finally {
    release.resolve()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}, 15_000)
