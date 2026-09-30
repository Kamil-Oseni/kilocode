import * as InstanceState from "@/effect/instance-state"
import { registerDisposer } from "@/effect/instance-registry"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Plugin } from "@/plugin"
import { Pty } from "@opencode-ai/core/pty"
import { PtyProtocol } from "@opencode-ai/core/pty/protocol"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { LocationServiceMap } from "@opencode-ai/core/location-services" // kilocode_change
import { locationServiceMapLayer } from "@/kilocode/pty/location-map" // kilocode_change
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Shell } from "@opencode-ai/core/shell"
import { CorsConfig, isAllowedRequestOrigin, type CorsOptions } from "@opencode-ai/server/cors"
import {
  PTY_CONNECT_TICKET_QUERY,
  PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER_VALUE,
} from "@/server/shared/pty-ticket"
import { Effect, Layer, Option, Queue, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import { CursorQuery, PtyConnectApi } from "../groups/pty"
import { WebSocketTracker } from "../websocket-tracker"

function validOrigin(request: HttpServerRequest.HttpServerRequest, opts: CorsOptions | undefined) {
  return isAllowedRequestOrigin(request.headers.origin, request.headers.host, opts)
}

// kilocode_change start - bound each slow PTY WebSocket without discarding accepted output frames
export function makePtyOutbox(wake: Queue.Queue<void>, detach: () => void) {
  // The PTY retains up to 2 Mi UTF-16 code units; 8 MiB admits even worst-case
  // UTF-8 replay plus live output before forcing a reconnect.
  const limit = { count: 256, bytes: 8 * 1024 * 1024 }
  const pending: { item: string | Uint8Array | Socket.CloseEvent; bytes: number }[] = []
  let bytes = 0
  let closed = false
  const signal = () => void Queue.offerUnsafe(wake, undefined)
  const end = (event: Socket.CloseEvent) => {
    if (closed) return
    closed = true
    pending.push({ item: event, bytes: 0 }) // reserve one terminal slot beyond the data limit
    signal()
  }
  const offer = (item: string | Uint8Array) => {
    if (closed) return false
    const size = typeof item === "string" ? Buffer.byteLength(item) : item.byteLength
    if (pending.length >= limit.count || bytes + size > limit.bytes) {
      detach()
      end(new Socket.CloseEvent(1013, "terminal output backlog"))
      return false
    }
    pending.push({ item, bytes: size })
    bytes += size
    signal()
    return true
  }
  const take = Effect.gen(function* () {
    while (true) {
      yield* Queue.take(wake)
      const frame = pending.shift()
      if (!frame) continue
      bytes -= frame.bytes
      if (pending.length) signal()
      return frame.item
    }
  })
  return {
    offer,
    end,
    take,
    get closed() {
      return closed
    },
    get depth() {
      return pending.length
    },
    get bytes() {
      return bytes
    },
  }
}
// kilocode_change end

const ticketScope = Effect.gen(function* () {
  const instance = yield* InstanceRef
  const workspaceID = yield* WorkspaceRef
  return { directory: instance?.directory, workspaceID }
})

// Legacy surface compatibility: before exited-session retention, sessions vanished the moment
// their process exited. These routes preserve that observable behavior — exited sessions are
// invisible here — while the canonical /api/pty surface exposes them until removal.
export const ptyHandlers = HttpApiBuilder.group(InstanceHttpApi, "pty", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig
    const plugin = yield* Plugin.Service
    const locations = yield* LocationServiceMap.Service
    // kilocode_change start
    const unregister = registerDisposer((directory, workspaceID) =>
      Effect.runPromise(
        locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(directory), workspaceID })),
      ),
    )
    // kilocode_change end
    yield* Effect.addFinalizer(() => Effect.sync(unregister))

    const pty = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      // kilocode_change start
      const instance = yield* InstanceState.context
      const workspaceID = yield* WorkspaceRef
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory), workspaceID })),
        ),
      )
      // kilocode_change end
    })

    const shells = Effect.fn("PtyHttpApi.shells")(function* () {
      return yield* Effect.promise(() => Shell.list())
    })

    const list = Effect.fn("PtyHttpApi.list")(function* () {
      const sessions = yield* pty(Pty.Service.use((service) => service.list()))
      return sessions.filter((info) => info.status === "running")
    })

    const create = Effect.fn("PtyHttpApi.create")(function* (ctx: { payload: typeof Pty.CreateInput.Type }) {
      const cwd = ctx.payload.cwd || (yield* InstanceState.context).directory
      const shell = yield* plugin.trigger("shell.env", { cwd }, { env: {} as Record<string, string> })
      return yield* pty(
        Pty.Service.use((service) =>
          service.create({
            ...ctx.payload,
            args: ctx.payload.args ? [...ctx.payload.args] : undefined,
            cwd,
            env: { ...ctx.payload.env, ...shell.env },
          }),
        ),
      )
    })

    const get = Effect.fn("PtyHttpApi.get")(function* (ctx: { params: { ptyID: PtyID } }) {
      return yield* pty(Pty.Service.use((service) => service.get(ctx.params.ptyID))).pipe(
        Effect.catchTag(
          "Pty.NotFoundError",
          (error) =>
            new ApiError.PtyNotFoundError({
              ptyID: error.ptyID,
              message: `PTY session not found: ${error.ptyID}`,
            }),
        ),
        Effect.flatMap((info) =>
          info.status === "running"
            ? Effect.succeed(info)
            : new ApiError.PtyNotFoundError({
                ptyID: ctx.params.ptyID,
                message: `PTY session not found: ${ctx.params.ptyID}`,
              }),
        ),
      )
    })

    const update = Effect.fn("PtyHttpApi.update")(function* (ctx: {
      params: { ptyID: PtyID }
      payload: typeof Pty.UpdateInput.Type
    }) {
      yield* get(ctx)
      return yield* pty(
        Pty.Service.use((service) =>
          service.update(ctx.params.ptyID, {
            ...ctx.payload,
            size: ctx.payload.size ? { ...ctx.payload.size } : undefined,
          }),
        ),
      ).pipe(
        Effect.catchTag(
          "Pty.NotFoundError",
          (error) =>
            new ApiError.PtyNotFoundError({
              ptyID: error.ptyID,
              message: `PTY session not found: ${error.ptyID}`,
            }),
        ),
      )
    })

    const remove = Effect.fn("PtyHttpApi.remove")(function* (ctx: { params: { ptyID: PtyID } }) {
      yield* pty(Pty.Service.use((service) => service.remove(ctx.params.ptyID))).pipe(
        Effect.catchTag(
          "Pty.NotFoundError",
          (error) =>
            new ApiError.PtyNotFoundError({
              ptyID: error.ptyID,
              message: `PTY session not found: ${error.ptyID}`,
            }),
        ),
      )
      return true
    })

    const connectToken = Effect.fn("PtyHttpApi.connectToken")(function* (ctx: { params: { ptyID: PtyID } }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE || !validOrigin(request, cors))
        return yield* new ApiError.PtyForbiddenError({ message: "Invalid PTY connect token request" })
      yield* get(ctx)
      return yield* tickets.issue({ ptyID: ctx.params.ptyID, ...(yield* ticketScope) })
    })

    return handlers
      .handle("shells", shells)
      .handle("list", list)
      .handle("create", create)
      .handle("get", get)
      .handle("update", update)
      .handle("remove", remove)
      .handle("connectToken", connectToken)
  }),
).pipe(Layer.provide(locationServiceMapLayer))

export const ptyConnectHandlers = HttpApiBuilder.group(PtyConnectApi, "pty-connect", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig
    const locations = yield* LocationServiceMap.Service
    // kilocode_change start
    const unregister = registerDisposer((directory, workspaceID) =>
      Effect.runPromise(
        locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(directory), workspaceID })),
      ),
    )
    // kilocode_change end
    yield* Effect.addFinalizer(() => Effect.sync(unregister))

    const pty = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      // kilocode_change start
      const instance = yield* InstanceState.context
      const workspaceID = yield* WorkspaceRef
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory), workspaceID })),
        ),
      )
      // kilocode_change end
    })

    return handlers.handleRaw(
      "connect",
      Effect.fn("PtyHttpApi.connect")(function* (ctx: {
        params: { ptyID: PtyID }
        request: HttpServerRequest.HttpServerRequest
      }) {
        const exists = yield* pty(Pty.Service.use((service) => service.get(ctx.params.ptyID))).pipe(
          Effect.map((info) => info.status === "running"),
          Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
        )
        if (!exists) return HttpServerResponse.empty({ status: 404 })

        const query = Schema.decodeUnknownOption(CursorQuery)(yield* HttpServerRequest.ParsedSearchParams)
        if (Option.isNone(query)) return HttpServerResponse.empty({ status: 400 })
        const ticket = new URL(ctx.request.url, "http://localhost").searchParams.get(PTY_CONNECT_TICKET_QUERY)
        if (ticket) {
          const valid = validOrigin(ctx.request, cors)
            ? yield* tickets.consume({ ticket, ptyID: ctx.params.ptyID, ...(yield* ticketScope) })
            : false
          if (!valid) return HttpServerResponse.empty({ status: 403 })
        }
        const parsedCursor = query.value.cursor === undefined ? undefined : Number(query.value.cursor)
        const cursor =
          parsedCursor !== undefined && Number.isSafeInteger(parsedCursor) && parsedCursor >= -1
            ? parsedCursor
            : undefined
        const socket = yield* Effect.orDie(ctx.request.upgrade)
        const write = yield* socket.writer
        const closeAccepted = (event: Socket.CloseEvent) =>
          socket
            .runRaw(() => Effect.void, { onOpen: write(event).pipe(Effect.catch(() => Effect.void)) })
            .pipe(
              Effect.timeout("1 second"),
              Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
              Effect.catch(() => Effect.void),
            )
        const registered = yield* WebSocketTracker.register(write(WebSocketTracker.SERVER_CLOSING_EVENT()))
        if (!registered) {
          yield* closeAccepted(WebSocketTracker.SERVER_CLOSING_EVENT())
          return HttpServerResponse.empty()
        }

        // kilocode_change start - reserve a terminal close slot after bounded, ordered output
        const wake = yield* Queue.dropping<void>(1)
        let release = () => {}
        const outbox = makePtyOutbox(wake, () => release())
        const attachment = yield* pty(
          Pty.Service.use((service) =>
            service.attach(ctx.params.ptyID, {
              cursor,
              onData: (chunk) => void outbox.offer(chunk),
              onEnd: () => outbox.end(new Socket.CloseEvent(1000)),
            }),
          ),
        ).pipe(
          Effect.catchTags({
            "Pty.NotFoundError": () =>
              closeAccepted(new Socket.CloseEvent(4404, "session not found")).pipe(Effect.as(undefined)),
            "Pty.ExitedError": () =>
              closeAccepted(new Socket.CloseEvent(4404, "session not found")).pipe(Effect.as(undefined)),
          }),
        )
        if (!attachment) return HttpServerResponse.empty()

        release = () => attachment.detach()
        for (const chunk of PtyProtocol.chunks(attachment.replay)) if (!outbox.offer(chunk)) break
        if (!outbox.closed) outbox.offer(PtyProtocol.metaFrame(attachment.cursor, attachment.replayGap))
        if (!outbox.closed) attachment.activate()

        const drain = Effect.gen(function* () {
          while (true) {
            const item = yield* outbox.take
            yield* write(item)
            if (item instanceof Socket.CloseEvent) return
          }
        })
        // kilocode_change end

        // The reader runs concurrently with the writer; whichever finishes first ends the
        // connection and the attachment is always released.
        yield* Effect.race(
          drain,
          socket.runRaw((message) => {
            const decoded = PtyProtocol.decodeInput(message)
            if (decoded !== undefined) attachment.write(decoded)
          }),
        ).pipe(
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.ensuring(Effect.sync(() => attachment.detach())),
          Effect.orDie,
        )
        return HttpServerResponse.empty()
      }),
    )
  }),
).pipe(Layer.provide(locationServiceMapLayer))
