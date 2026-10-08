import { Context, type Effect, type Scope } from "effect"
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import type * as Socket from "effect/unstable/socket/Socket"

export class Service extends Context.Service<
  Service,
  {
    readonly upgrade: (request: HttpServerRequest) => Effect.Effect<Socket.Socket, Socket.SocketError, Scope.Scope>
    readonly register: (close: Effect.Effect<void, unknown>) => Effect.Effect<boolean, never, Scope.Scope>
  }
>()("raya/pty/Transport") {}
