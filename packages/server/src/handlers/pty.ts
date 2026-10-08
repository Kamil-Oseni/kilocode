import { Pty } from "@opencode-ai/core/pty"
import { PtyProtocol } from "@opencode-ai/core/pty/protocol"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { Location } from "@opencode-ai/core/location"
import { Effect, Option, Queue } from "effect" // kilocode_change
import { Service as Transport } from "@opencode-ai/core/kilocode/pty-transport" // kilocode_change
import { makePtyOutbox } from "@opencode-ai/core/kilocode/pty-output" // kilocode_change
import { drain } from "@opencode-ai/core/kilocode/pty-closing" // kilocode_change
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { Api } from "../api"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
import { ForbiddenError, PtyNotFoundError } from "@opencode-ai/protocol/errors"
import {
  PTY_CONNECT_TICKET_QUERY,
  PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER_VALUE,
  PTY_REPLAY_EXITED_QUERY,
} from "@opencode-ai/protocol/groups/pty"
import { response } from "../location"
import { PtyEnvironment } from "../pty-environment"

const ticketScope = Effect.gen(function* () {
  const location = yield* Location.Service
  return { directory: location.directory as string, workspaceID: location.workspaceID }
})

export const PtyHandler = HttpApiBuilder.group(Api, "server.pty", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig
    const environment = yield* PtyEnvironment.Service

    return handlers
      .handle(
        "pty.list",
        Effect.fn(function* () {
          return yield* response((yield* Pty.Service).list())
        }),
      )
      .handle(
        "pty.create",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          const location = yield* Location.Service
          const cwd = ctx.payload.cwd || location.directory
          return yield* response(
            pty.create({
              ...ctx.payload,
              args: ctx.payload.args ? [...ctx.payload.args] : undefined,
              cwd,
              env: {
                ...ctx.payload.env,
                ...(yield* environment.get({ directory: location.directory, cwd })),
              },
            }),
          )
        }),
      )
      .handle(
        "pty.get",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(
            pty.get(ctx.params.ptyID).pipe(
              Effect.catchTag(
                "Pty.NotFoundError",
                () =>
                  new PtyNotFoundError({
                    ptyID: ctx.params.ptyID,
                    message: `PTY session not found: ${ctx.params.ptyID}`,
                  }),
              ),
            ),
          )
        }),
      )
      .handle(
        "pty.update",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(
            pty
              .update(ctx.params.ptyID, {
                ...ctx.payload,
                size: ctx.payload.size ? { ...ctx.payload.size } : undefined,
              })
              .pipe(
                Effect.catchTag(
                  "Pty.NotFoundError",
                  () =>
                    new PtyNotFoundError({
                      ptyID: ctx.params.ptyID,
                      message: `PTY session not found: ${ctx.params.ptyID}`,
                    }),
                ),
              ),
          )
        }),
      )
      .handle(
        "pty.remove",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          yield* pty.remove(ctx.params.ptyID).pipe(
            Effect.catchTag(
              "Pty.NotFoundError",
              () =>
                new PtyNotFoundError({
                  ptyID: ctx.params.ptyID,
                  message: `PTY session not found: ${ctx.params.ptyID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "pty.connectToken",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          // The custom header forces a CORS preflight, so cross-origin browser pages cannot
          // mint tickets without passing the server's origin policy.
          if (
            request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            !isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)
          )
            return yield* new ForbiddenError({ message: "Invalid PTY connect token request" })
          const pty = yield* Pty.Service
          yield* pty.get(ctx.params.ptyID).pipe(
            Effect.catchTag(
              "Pty.NotFoundError",
              () =>
                new PtyNotFoundError({
                  ptyID: ctx.params.ptyID,
                  message: `PTY session not found: ${ctx.params.ptyID}`,
                }),
            ),
          )
          return yield* response(tickets.issue({ ptyID: ctx.params.ptyID, ...(yield* ticketScope) }))
        }),
      )
      .handleRaw(
        "pty.connect",
        Effect.fn("PtyHandler.connect")(function* (ctx) {
          const pty = yield* Pty.Service
          const exists = yield* pty.get(ctx.params.ptyID).pipe(
            Effect.as(true),
            Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
          )
          if (!exists) return HttpServerResponse.empty({ status: 404 })

          const url = new URL(ctx.request.url, "http://localhost")
          const ticket = url.searchParams.get(PTY_CONNECT_TICKET_QUERY)
          if (ticket) {
            const valid = isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors)
              ? yield* tickets.consume({ ticket, ptyID: ctx.params.ptyID, ...(yield* ticketScope) })
              : false
            if (!valid) return HttpServerResponse.empty({ status: 403 })
          }
          const parsedCursor = url.searchParams.get("cursor")
          const cursorNumber = parsedCursor === null ? undefined : Number(parsedCursor)
          const cursor =
            cursorNumber !== undefined && Number.isSafeInteger(cursorNumber) && cursorNumber >= -1
              ? cursorNumber
              : undefined

          // kilocode_change start - consume the owned upgrade only after typed-route authentication
          const transport = yield* Effect.serviceOption(Transport)
          if (Option.isNone(transport)) return HttpServerResponse.empty({ status: 503 })
          const socket = yield* Effect.orDie(transport.value.upgrade(ctx.request))
          // kilocode_change end
          const write = yield* socket.writer
          const closeAccepted = (event: Socket.CloseEvent) =>
            socket
              .runRaw(() => Effect.void, { onOpen: write(event).pipe(Effect.catch(() => Effect.void)) })
              .pipe(
                Effect.timeout("1 second"),
                Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
                Effect.catch(() => Effect.void),
              )

          // kilocode_change start - share bounded output and shutdown ownership with the legacy route
          const closing = new Socket.CloseEvent(1001, "server closing")
          const registered = yield* transport.value.register(write(closing))
          if (!registered) {
            yield* closeAccepted(closing)
            return HttpServerResponse.empty()
          }
          const wake = yield* Queue.dropping<void>(1)
          let release = () => {}
          const outbox = makePtyOutbox(wake, () => release())
          // kilocode_change end
          const attachment = yield* pty
            .attach(ctx.params.ptyID, {
              cursor,
              onData: (chunk) => void outbox.offer(chunk), // kilocode_change
              onEnd: () => outbox.end(new Socket.CloseEvent(1000)), // kilocode_change
              allowExited: url.searchParams.get(PTY_REPLAY_EXITED_QUERY) === "1", // kilocode_change
            })
            .pipe(
              Effect.catchTags({
                "Pty.NotFoundError": () =>
                  closeAccepted(new Socket.CloseEvent(4404, "session not found")).pipe(Effect.as(undefined)),
                "Pty.ExitedError": () =>
                  closeAccepted(new Socket.CloseEvent(4404, "session exited")).pipe(Effect.as(undefined)),
              }),
            )
          if (!attachment) return HttpServerResponse.empty()

          // kilocode_change start - retain replay order, report gaps, and release the PTY on overflow
          release = () => attachment.detach()
          for (const chunk of PtyProtocol.chunks(attachment.replay)) if (!outbox.offer(chunk)) break
          if (!outbox.closed) outbox.offer(PtyProtocol.metaFrame(attachment.cursor, attachment.replayGap))
          if (!outbox.closed) attachment.activate()
          // kilocode_change end

          yield* Effect.race(
            drain(outbox.take, write), // kilocode_change
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
)
