import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@opencode-ai/core/database/database"
import { Conflict, Invalid, Message, NotFound, RayaContactOutbox } from "@/kilocode/contact/outbox"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import {
  ConflictError,
  InvalidRequestError,
  notFound,
  type ApiNotFoundError,
} from "@/server/routes/instance/httpapi/errors"

type Failure = InvalidRequestError | ApiNotFoundError | ConflictError

function api<A, E, R>(self: Effect.Effect<A, E, R>) {
  return self.pipe(
    Effect.catch((err): Effect.Effect<never, Failure> => {
      if (Schema.is(Invalid)(err))
        return Effect.fail(new InvalidRequestError({ message: err.message, kind: "contact-destination" }))
      if (Schema.is(NotFound)(err)) return Effect.fail(notFound(err.message))
      if (Schema.is(Conflict)(err)) return Effect.fail(new ConflictError({ message: err.message }))
      return Effect.die(err)
    }),
  )
}

function view(item: Message) {
  return {
    version: item.version,
    id: item.id,
    source: item.source,
    destinationID: item.destinationID,
    destinationRevision: item.destinationRevision,
    ...(item.agentID ? { agentID: item.agentID } : {}),
    ...(item.organizationID ? { organizationID: item.organizationID } : {}),
    ...(item.sessionID ? { sessionID: item.sessionID } : {}),
    body: item.body,
    state: item.state,
    attempts: item.attempts,
    availableAt: item.availableAt,
    ...(item.leaseUntil !== undefined ? { leaseUntil: item.leaseUntil } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.receipt ? { receipt: item.receipt } : {}),
  }
}

export const contactHandlers = HttpApiBuilder.group(InstanceHttpApi, "raya-contact", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const outbox = RayaContactOutbox.make(database)

    return handlers
      .handle("contactDestinationList", (ctx) => outbox.listDestinations(ctx.query.limit ?? 100))
      .handle("contactDestinationAuthorize", (ctx) => api(outbox.authorize(ctx.payload)))
      .handle("contactDestinationGet", (ctx) => api(outbox.getDestination(ctx.params.destinationID)))
      .handle("contactDestinationRevoke", (ctx) => api(outbox.revoke(ctx.params.destinationID, ctx.payload.revision)))
      .handle("contactMessageList", (ctx) =>
        outbox.listMessages(ctx.query.limit ?? 100).pipe(Effect.map((items) => items.map(view))),
      )
      .handle("contactMessageGet", (ctx) => api(outbox.get(ctx.params.messageID)).pipe(Effect.map(view)))
  }),
)
