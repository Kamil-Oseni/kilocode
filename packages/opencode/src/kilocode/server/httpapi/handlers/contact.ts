import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { RayaAdminLog } from "@/kilocode/admin/log"
import { Conflict, type Enqueue, Invalid, Message, NotFound, RayaContactOutbox } from "@/kilocode/contact/outbox"
import { RayaContactMessenger } from "@/kilocode/contact/raya"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import {
  ConflictError,
  InvalidRequestError,
  notFound,
  type ApiNotFoundError,
} from "@/server/routes/instance/httpapi/errors"
import { Storage } from "@/storage/storage"

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
    const storage = yield* Storage.Service
    const logs = yield* RayaAdminLog.Service
    const outbox = RayaContactOutbox.make(database)
    const tasks = RayaTask.make({ storage, database })
    const organizations = RayaTaskOrganization.make(database, tasks, storage)
    const exists = (id: string) =>
      tasks.get(id).pipe(
        Effect.map((item) => item.enabled),
        Effect.catchTag("RayaTask.NotFoundError", () => Effect.succeed(false)),
      )
    const send = Effect.fn("RayaContactHttpApi.send")(function* (payload: Enqueue) {
      const state = yield* InstanceState.context
      const messenger = RayaContactMessenger.make(database, {
        exists,
        permit: (input, target) =>
          target.scope.kind !== "organization"
            ? Effect.succeed(true)
            : input.agentID
              ? organizations.contains(target.scope.id, [input.agentID])
              : Effect.succeed(false),
        report: (event) => logs.write(event).pipe(Effect.provideService(InstanceRef, state)),
      })
      return yield* api(messenger.send(payload)).pipe(Effect.map(view))
    })

    return handlers
      .handle("contactDestinationList", (ctx) => outbox.listDestinations(ctx.query.limit ?? 100))
      .handle("contactDestinationAuthorize", (ctx) => api(outbox.authorize(ctx.payload)))
      .handle("contactDestinationGet", (ctx) => api(outbox.getDestination(ctx.params.destinationID)))
      .handle("contactDestinationRevoke", (ctx) => api(outbox.revoke(ctx.params.destinationID, ctx.payload.revision)))
      .handle("contactMessageList", (ctx) =>
        outbox.listMessages(ctx.query.limit ?? 100).pipe(Effect.map((items) => items.map(view))),
      )
      .handle("contactMessageSend", (ctx) => send(ctx.payload))
      .handle("contactMessageGet", (ctx) => api(outbox.get(ctx.params.messageID)).pipe(Effect.map(view)))
  }),
)
