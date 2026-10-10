import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { WebSocket } from "../../node_modules/@raya/ws/wrapper.mjs"
import { Replay } from "@opencode-ai/core/kilocode/pty/replay"
import { PtyProtocol } from "@opencode-ai/core/pty/protocol"
import { fileURLToPath } from "node:url"
import { createServer } from "node:http"
import type { Socket as Connection } from "node:net"
import { NodeHttpServer } from "@effect/platform-node"
import { Cause, Deferred, Effect, Exit, Layer, Queue } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { drain } from "../../src/kilocode/pty/closing"
import * as Transport from "../../src/kilocode/pty/transport"
import { makePtyOutbox } from "../../src/server/routes/instance/httpapi/handlers/pty"

const node = Bun.which("node")
const fixture = fileURLToPath(new URL("./pty-close-reader.cjs", import.meta.url))

test("bounds the fallback close when neither the send nor close request settles", async () => {
  const frames: Array<string | Uint8Array | Socket.CloseEvent> = []
  const started = Date.now()
  await Effect.runPromise(
    drain(
      Effect.succeed("output"),
      (item) => Effect.sync(() => frames.push(item)).pipe(Effect.andThen(Effect.never)),
      20,
    ).pipe(Effect.timeout("1 second")),
  )
  expect(frames).toHaveLength(2)
  expect(frames[0]).toBe("output")
  expect(frames[1]).toBeInstanceOf(Socket.CloseEvent)
  const close = frames[1]
  if (!(close instanceof Socket.CloseEvent)) throw new Error("Expected fallback close request")
  expect(close.code).toBe(1013)
  expect(Date.now() - started).toBeLessThan(1000)
})

async function run(stalled: boolean, pressure = false) {
  if (!node) throw new Error("Real Node socket client is required")
  const state = { released: false, finished: false, elapsed: 0, detached: 0, accepted: 0, bytes: 0, depth: 0 }
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
      const transport = yield* Transport.Service
      const socket = yield* transport.upgrade(request)
      const write = yield* socket.writer
      const queue = yield* Queue.unbounded<string | Socket.CloseEvent>()
      const wake = yield* Queue.dropping<void>(1)
      const outbox = makePtyOutbox(wake, () => state.detached++)
      const started = Date.now()
      yield* Effect.race(
        drain(pressure ? outbox.take : Queue.take(queue), write, stalled ? 500 : "5 seconds"),
        socket.runRaw(
          () =>
            Effect.gen(function* () {
              if (pressure) {
                for (let n = 0; n < 1024; n++) {
                  if (!outbox.offer("x".repeat(65536))) break
                  state.accepted++
                }
                state.bytes = outbox.bytes
                state.depth = outbox.depth
                return
              }
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
    Layer.provideMerge(Transport.layer(http)),
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
      const child = Bun.spawn([node, fixture, url, pressure ? "pressure" : stalled ? "stalled" : "resume"], {
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

test("drains the bounded application outbox through actual native sends before reconnect closure", async () => {
  const { state, result } = await run(false, true)
  expect(result.err).toBe("")
  expect(result.code).toBe(0)
  const receipt = JSON.parse(result.out)
  expect(state.accepted).toBe(128)
  expect(state.detached).toBe(1)
  expect(state.bytes).toBe(8 * 1024 * 1024)
  expect(state.depth).toBe(129)
  expect(receipt.after).toBe(receipt.settled)
  expect(receipt.bytes).toBe(state.accepted * 65536)
  expect(receipt.code).toBe(1013)
  expect(receipt.reason).toBe("terminal output backlog")
  expect(state.released).toBe(true)
}, 10000)

// Observe the pinned sender without replacing its native write or manufacturing
// completion. These sockets belong only to this isolated router and child.
async function sustained(mode: "resume" | "never" | "disconnect") {
  if (!node) throw new Error("Real Node socket client is required")
  const state = {
    accepted: 0,
    completed: 0,
    active: 0,
    peak: 0,
    buffered: 0,
    bytes: 0,
    depth: 0,
    detached: 0,
    interleaved: false,
    released: false,
    forced: false,
    elapsed: 0,
    closed: false,
    errors: 0,
    callbacks: 0,
    writes: 0,
    started: 0,
    finished: 0,
    cancelled: 0,
    failed: 0,
  }
  const track =
    (write: (item: string | Uint8Array | Socket.CloseEvent) => Effect.Effect<void, Socket.SocketError>) =>
    (item: string | Uint8Array | Socket.CloseEvent) =>
      Effect.suspend(() => {
        state.writes++
        state.started++
        return write(item).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (!Exit.isFailure(exit)) return
              if (Cause.hasInterrupts(exit.cause)) state.cancelled++
              if (!Cause.hasInterruptsOnly(exit.cause)) state.failed++
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              state.writes--
              state.finished++
            }),
          ),
        )
      })
  const replay = new Replay(2 * 1024 * 1024)
  const hash = createHash("sha256")
  const pressure = Deferred.makeUnsafe<void>()
  const blocked = Deferred.makeUnsafe<void>()
  const retired = Promise.withResolvers<void>()
  let owner: WebSocket | undefined
  // oxlint-disable-next-line typescript-eslint/unbound-method -- Preserve the actual sender and delegate with its original WebSocket receiver through .call below.
  const original = WebSocket.prototype.send
  const observer = spyOn(WebSocket.prototype, "send").mockImplementation(function (
    this: WebSocket,
    data: Parameters<typeof original>[0],
    options?: Parameters<typeof original>[1] | Parameters<typeof original>[2],
    callback?: Parameters<typeof original>[2],
  ) {
    if (data === "READY") {
      if (owner) throw new Error("Sustained fixture owner already selected")
      // oxlint-disable-next-line typescript-eslint/no-this-alias -- Bind observations to the exact original READY socket; reconnect must not enter its callback accounting.
      owner = this
      this.once("close", () => {
        state.closed = true
        if (!state.active) retired.resolve()
      })
      this.on("error", () => state.errors++)
    }
    const terminal = this === owner && typeof data === "string" && data.length === 65536
    if (terminal) {
      state.active++
      state.peak = Math.max(state.peak, state.active)
    }
    const done = typeof options === "function" ? options : callback
    original.call(this, data, typeof options === "function" ? {} : (options ?? {}), (err) => {
      state.buffered = Math.max(state.buffered, this.bufferedAmount)
      if (terminal) {
        state.active--
        state.callbacks++
        if (!err) state.completed++
        if (state.closed && !state.active) retired.resolve()
      }
      done?.(err)
    })
    state.buffered = Math.max(state.buffered, this.bufferedAmount)
    if (terminal && state.active && this.bufferedAmount > 0 && state.completed > 0)
      Deferred.doneUnsafe(blocked, Effect.void)
  })
  const http = createServer()
  const connections = new Set<Connection>()
  http.on("connection", (socket) => {
    connections.add(socket)
    socket.once("close", () => connections.delete(socket))
  })
  const finished = Deferred.makeUnsafe<void>()
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/socket",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const transport = yield* Transport.Service
        const socket = yield* transport.upgrade(request)
        const write = track(yield* socket.writer)
        const wake = yield* Queue.dropping<void>(1)
        const outbox = makePtyOutbox(wake, () => state.detached++)
        const started = Date.now()
        yield* Effect.race(
          drain(outbox.take, write, mode === "resume" ? "5 seconds" : 500),
          socket.runRaw(
            () =>
              Effect.gen(function* () {
                for (let n = 0; n < 1024; n++) {
                  const frame = String(n).padStart(8, "0") + ":" + "x".repeat(65527)
                  if (!outbox.offer(frame)) {
                    yield* Deferred.succeed(pressure, undefined)
                    break
                  }
                  hash.update(frame)
                  replay.append(frame)
                  state.accepted++
                  state.bytes = Math.max(state.bytes, outbox.bytes)
                  state.depth = Math.max(state.depth, outbox.depth)
                  state.interleaved ||= state.completed > 0
                  // Yield a real event-loop turn between offers so native sends and the
                  // producer compete; the burst-only case above does not exercise this.
                  yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
                }
                if (!outbox.closed) outbox.end(new Socket.CloseEvent(1013, "terminal output backlog"))
              }),
            { onOpen: Effect.orDie(write("READY")) },
          ),
        ).pipe(
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.ensuring(
            Effect.gen(function* () {
              state.released = true
              state.elapsed = Date.now() - started
              yield* Deferred.succeed(finished, undefined)
            }),
          ),
        )
        return HttpServerResponse.empty()
      }),
    ),
    HttpRouter.add(
      "GET",
      "/replay",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const transport = yield* Transport.Service
        const socket = yield* transport.upgrade(request)
        const write = track(yield* socket.writer)
        const queue = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>()
        for (const chunk of PtyProtocol.chunks(replay.slice())) yield* Queue.offer(queue, chunk)
        const cursor = state.accepted * 65536
        yield* Queue.offer(
          queue,
          PtyProtocol.metaFrame(cursor, {
            requestedCursor: 0,
            retainedFrom: cursor - replay.length,
            retainedTo: cursor,
          }),
        )
        yield* Queue.offer(queue, new Socket.CloseEvent(1000))
        yield* Effect.race(
          drain(Queue.take(queue), write),
          socket.runRaw(() => Effect.void),
        ).pipe(Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void))
        return HttpServerResponse.empty()
      }),
    ),
  )
  const layer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => http, { port: 0, gracefulShutdownTimeout: "1 second" })),
    Layer.provideMerge(Transport.layer(http)),
  )
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const socket of connections) socket.destroy()
            http.close()
          }),
        )
        const url = HttpServer.formatAddress(server.address).replace(/^http/, "ws")
        const child = Bun.spawn(
          [node, fileURLToPath(new URL("./pty-sustained-reader.cjs", import.meta.url)), url, mode],
          {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
          },
        )
        // Drain both original readers immediately; the fixture emits one bounded
        // receipt, and emergency cleanup is explicitly disqualified below.
        const out = new Response(child.stdout).text()
        const err = new Response(child.stderr).text()
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            if (child.exitCode === null) {
              state.forced = true
              child.kill()
            }
            await Promise.all([child.exited, out, err])
          }),
        )
        if (mode === "resume") {
          yield* Deferred.await(pressure).pipe(Effect.timeout("5 seconds"))
          yield* Effect.promise(() => Promise.resolve(child.stdin.write("resume\n")))
        }
        if (mode === "disconnect") {
          yield* Deferred.await(blocked).pipe(Effect.timeout("5 seconds"))
          yield* Effect.promise(() => Promise.resolve(child.stdin.write("disconnect\n")))
        }
        yield* Deferred.await(finished).pipe(Effect.timeout("6 seconds"))
        yield* Effect.promise(() => Promise.resolve(child.stdin.write("released\n")))
        yield* Effect.promise(() => Promise.resolve(child.stdin.end()))
        const result = yield* Effect.promise(async () => ({
          pid: child.pid,
          code: await child.exited,
          out: await out,
          err: await err,
        }))
        return { state, result, digest: hash.digest("hex"), replay: replay.slice() }
      }).pipe(
        Effect.onError(() => Effect.sync(() => console.error({ mode, state }))),
        Effect.scoped,
        Effect.provide(layer),
      ),
    )
    // Route release is not the native callback's join. Observe the original
    // sender after whole-layer finalization, retaining uncertainty on expiry.
    const timer = setTimeout(() => retired.resolve(), 500)
    try {
      await retired.promise
    } finally {
      clearTimeout(timer)
    }
    console.error({
      mode,
      ownerClosed: state.closed,
      pendingCallbacks: state.active,
      callbacks: state.callbacks,
      errors: state.errors,
      activeWrites: state.writes,
      startedWrites: state.started,
      finishedWrites: state.finished,
      cancelledWrites: state.cancelled,
      failedWrites: state.failed,
    })
    return result
  } finally {
    observer.mockRestore()
  }
}

test("sustained native sends retain ordered overflow output and replay on a fresh socket", async () => {
  const { state, result, digest, replay } = await sustained("resume")
  expect(result.code).toBe(0)
  expect(result.err).toBe("")
  const receipt = JSON.parse(result.out)
  expect(state.interleaved).toBe(true)
  expect(state.peak).toBe(1)
  expect(state.buffered).toBeGreaterThan(0)
  expect(state.buffered).toBeLessThanOrEqual(65546)
  expect(state.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
  expect(state.depth).toBeLessThanOrEqual(256)
  expect(state.detached).toBe(1)
  expect(receipt.code).toBe(1013)
  expect(receipt.reason).toBe("terminal output backlog")
  expect(receipt.frames).toBe(state.accepted)
  expect(receipt.digest).toBe(digest)
  expect(state.completed).toBe(state.accepted)
  expect(receipt.replay).toBe(replay.length)
  expect(receipt.replayDigest).toBe(createHash("sha256").update(replay).digest("hex"))
  expect(receipt.gap).toEqual({
    cursor: state.accepted * 65536,
    replayGap: {
      requestedCursor: 0,
      retainedFrom: state.accepted * 65536 - replay.length,
      retainedTo: state.accepted * 65536,
    },
  })
  expect(state.released).toBe(true)
  expect(state.closed).toBe(true)
  expect(state.active).toBe(0)
  expect(state.writes).toBe(0)
  expect(state.started).toBe(state.finished)
  expect(state.forced).toBe(false)
}, 10000)

for (const mode of ["never", "disconnect"] as const)
  test(`sustained native sends release original scopes when the peer ${mode === "never" ? "never resumes" : "disconnects during a send"}`, async () => {
    const { state, result } = await sustained(mode)
    expect(result.code).toBe(0)
    expect(result.err).toBe("")
    expect(state.interleaved).toBe(true)
    expect(state.peak).toBe(1)
    expect(state.buffered).toBeGreaterThan(0)
    expect(state.buffered).toBeLessThanOrEqual(65546)
    expect(state.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(state.depth).toBeLessThanOrEqual(256)
    expect(state.released).toBe(true)
    expect(state.closed).toBe(true)
    // ARCH03 requires drain OR cancellation of owned work. Bun1.4.2 can
    // omit the raw send callback after genuine socket close (34924); retain
    // that diagnostic without claiming callback join or successful delivery.
    expect(state.writes).toBe(0)
    expect(state.started).toBe(state.finished)
    expect(state.cancelled + state.failed).toBeGreaterThan(0)
    expect(state.forced).toBe(false)
    expect(state.elapsed).toBeLessThan(6000)
    if (mode === "never") expect(state.elapsed).toBeGreaterThanOrEqual(450)
  }, 10000)
