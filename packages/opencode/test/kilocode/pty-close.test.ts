import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "node:http"
import type { Socket as Connection } from "node:net"
import { NodeHttpServer } from "@effect/platform-node"
import { Deferred, Effect, Layer, Queue } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { drain } from "../../src/kilocode/pty/closing"

const node = Bun.which("node")
const fixture = fileURLToPath(new URL("./pty-close-reader.cjs", import.meta.url))

async function run(stalled: boolean) {
  if (!node) throw new Error("Real Node socket client is required")
  const state = { released: false, finished: false, elapsed: 0 }
  const http = createServer()
  const connections = new Set<Connection>()
  http.on("connection", (connection) => {
    connections.add(connection)
    connection.once("close", () => connections.delete(connection))
  })
  const finished = Deferred.makeUnsafe<void>()
  const routes = HttpRouter.add(
    "GET",
    "/socket",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const socket = yield* request.upgrade
      const write = yield* socket.writer
      const queue = yield* Queue.unbounded<string | Socket.CloseEvent>()
      const started = Date.now()
      yield* Effect.race(
        drain(Queue.take(queue), write, stalled ? 500 : "5 seconds"),
        socket.runRaw(
          () =>
            Effect.gen(function* () {
              for (let n = 0; n < 128; n++) yield* Queue.offer(queue, "x".repeat(8192))
              yield* Queue.offer(queue, new Socket.CloseEvent(1013, "terminal output backlog"))
            }),
          { onOpen: Effect.orDie(write("READY")) },
        ),
      ).pipe(
        Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
        Effect.ensuring(
          Effect.gen(function* () {
            state.released = true
            state.finished = true
            state.elapsed = Date.now() - started
            yield* Deferred.succeed(finished, undefined)
          }),
        ),
      )
      return HttpServerResponse.empty()
    }),
  )
  const layer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => http, { port: 0, gracefulShutdownTimeout: "1 second" })),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const connection of connections) connection.destroy()
          http.close()
        }),
      )
      const url = HttpServer.formatAddress(server.address).replace(/^http/, "ws") + "/socket"
      const child = Bun.spawn([node, fixture, url, stalled ? "stalled" : "resume"], {
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (child.exitCode === null) child.kill()
          await child.exited
        }),
      )
      yield* Deferred.await(finished).pipe(
        Effect.timeout("6 seconds"),
        Effect.onError(() =>
          Effect.promise(async () => {
            child.kill()
            await child.exited
            console.error({ url, state, err: await new Response(child.stderr).text() })
          }),
        ),
      )
      if (stalled) child.kill()
      const result = yield* Effect.promise(async () => ({
        code: await child.exited,
        out: await new Response(child.stdout).text(),
        err: await new Response(child.stderr).text(),
      }))
      return { state, result }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )
}

test("preserves all queued frames and the close code while a real Node reader stalls", async () => {
  const { state, result } = await run(false)
  expect(result.err).toBe("")
  expect(result.code).toBe(0)
  const receipt = JSON.parse(result.out)
  expect(receipt.runtime).toBe("node")
  expect(receipt.after).toBe(receipt.settled)
  expect(receipt.bytes).toBe(128 * 8192)
  expect(receipt.code).toBe(1013)
  expect(receipt.reason).toBe("terminal output backlog")
  expect(state.released).toBe(true)
  expect(state.finished).toBe(true)
  expect(state.elapsed).toBeGreaterThanOrEqual(250)
}, 10000)

test("releases the scoped reader at the deadline when its peer never resumes", async () => {
  const { state } = await run(true)
  expect(state.released).toBe(true)
  expect(state.finished).toBe(true)
  expect(state.elapsed).toBeGreaterThanOrEqual(450)
  expect(state.elapsed).toBeLessThan(2000)
}, 10000)
