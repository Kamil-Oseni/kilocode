// Use the pinned package's published server entry explicitly: Bun replaces bare
// ws, while the CLI's browser condition otherwise selects the browser-only stub.
import { WebSocketServer, type WebSocket } from "../../../node_modules/@raya/ws/wrapper.mjs"
import { Deferred, Effect, Layer } from "effect"
import { Service } from "@opencode-ai/core/kilocode/pty-transport"
import { WebSocketTracker } from "../../server/routes/instance/httpapi/websocket-tracker"
import * as Socket from "effect/unstable/socket/Socket"
import { IncomingMessage, type Server } from "node:http"
import type { Duplex } from "node:stream"

export { Service }

const failure = (cause: unknown) => new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) })

// Capture only the original upgrade arguments here. The typed, authenticated
// route alone consumes them and performs the handshake; other routes keep their
// platform upgrade implementation.
export function layer(server: Server) {
  return Layer.effect(Service)(
    Effect.gen(function* () {
      const pending = new WeakMap<IncomingMessage, { socket: Duplex; head: Buffer }>()
      const capture = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        pending.set(request, { socket, head })
      }
      server.prependListener("upgrade", capture)
      const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
      yield* Effect.addFinalizer(() =>
        Effect.callback<void>((resume) => {
          server.off("upgrade", capture)
          for (const ws of wss.clients) ws.terminate()
          wss.close(() => resume(Effect.void))
        }),
      )

      return Service.of({
        register: WebSocketTracker.register,
        upgrade: (request) =>
          Effect.gen(function* () {
            const source = request.source
            if (!(source instanceof IncomingMessage)) return yield* Effect.fail(failure("Unsupported upgrade request"))
            const captured = pending.get(source)
            if (!captured) return yield* Effect.fail(failure("Upgrade arguments unavailable or already consumed"))
            pending.delete(source)
            const ready = Deferred.makeUnsafe<WebSocket, Socket.SocketError>()
            const acquire = Effect.acquireRelease(
              Effect.callback<WebSocket, Socket.SocketError>((resume) => {
                let done = false
                const cleanup = () => {
                  captured.socket.off("error", error)
                  captured.socket.off("close", close)
                }
                const finish = (result: Effect.Effect<WebSocket, Socket.SocketError>) => {
                  if (done) return
                  done = true
                  cleanup()
                  resume(result)
                }
                const error = (err: Error) => finish(Effect.fail(failure(err)))
                const close = () => finish(Effect.fail(failure("Connection closed before upgrade")))
                captured.socket.once("error", error)
                captured.socket.once("close", close)
                wss.handleUpgrade(source, captured.socket, captured.head, (ws) => finish(Effect.succeed(ws)))
                return Effect.sync(() => {
                  done = true
                  cleanup()
                })
              }).pipe(
                Effect.tap((ws) => Deferred.succeed(ready, ws)),
                Effect.onError((cause) => Deferred.failCause(ready, cause)),
              ),
              (ws) => Effect.sync(() => ws.terminate()),
            )
            // The platform already uses the same DOM event surface from ws. Its
            // additional Node binary modes are not exposed through this adapter.
            const socket = yield* Socket.fromWebSocket(
              acquire.pipe(
                // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- ws implements the platform's DOM event contract, with additional Node binary modes.
                Effect.map((ws) => ws as unknown as globalThis.WebSocket),
              ),
            )
            const original = yield* socket.writer
            return Socket.make({
              runRaw: socket.runRaw,
              writer: Effect.succeed((item) => {
                if (item instanceof Socket.CloseEvent) return original(item)
                return Effect.flatMap(Deferred.await(ready), (ws) =>
                  Effect.callback<void, Socket.SocketError>((resume) => {
                    let done = false
                    const cleanup = () => {
                      ws.off("error", error)
                      ws.off("close", close)
                    }
                    const finish = (result: Effect.Effect<void, Socket.SocketError>) => {
                      if (done) return
                      done = true
                      cleanup()
                      resume(result)
                    }
                    const error = (err: Error) => finish(Effect.fail(failure(err)))
                    const close = () => finish(Effect.fail(failure("Connection closed during send")))
                    ws.once("error", error)
                    ws.once("close", close)
                    ws.send(item, { compress: false }, (err) => finish(err ? Effect.fail(failure(err)) : Effect.void))
                    return Effect.sync(() => {
                      done = true
                      cleanup()
                    })
                  }),
                )
              }),
            })
          }),
      })
    }),
  )
}
