import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { PersonalTodoApplication } from "@/kilocode/personal-todo/application"
import { PersonalTodoProposal } from "@/kilocode/personal-todo/proposal"
import { Storage } from "@/storage/storage"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import {
  ApiNotFoundError,
  ConflictError,
  InvalidRequestError,
  notFound,
  UnknownError,
} from "@/server/routes/instance/httpapi/errors"
import {
  PersonalTodoProposalStaleRevisionError,
  PersonalTodoStaleRevisionError,
  PersonalTodoUpdatePayload,
} from "../groups/personal-todo"

function api<A, R>(
  self: Effect.Effect<A, PersonalTodo.InputError | PersonalTodo.ConflictError | PersonalTodo.StaleRevisionError, R>,
) {
  return self.pipe(
    Effect.catchTag("PersonalTodoInputError", (err) =>
      Effect.fail(new InvalidRequestError({ message: err.message, kind: "personal-todo", field: err.field })),
    ),
    Effect.catchTag("PersonalTodoConflictError", (err) =>
      Effect.fail(new ConflictError({ message: err.message, resource: err.id })),
    ),
    Effect.catchTag("PersonalTodoStaleRevisionError", (err) =>
      Effect.fail(
        new PersonalTodoStaleRevisionError({
          name: "PersonalTodoStaleRevisionError",
          data: {
            id: err.id,
            operation: err.operation,
            expected: err.expected,
            actual: err.actual,
            message: err.message,
          },
        }),
      ),
    ),
  )
}

type ProposalError =
  | PersonalTodo.InputError
  | PersonalTodo.ConflictError
  | PersonalTodo.StaleRevisionError
  | PersonalTodoProposal.InputError
  | PersonalTodoProposal.ConflictError
  | PersonalTodoProposal.CorruptError
  | PersonalTodoApplication.InputError
  | PersonalTodoApplication.NotFoundError
  | PersonalTodoApplication.ConflictError
  | PersonalTodoApplication.StaleRevisionError
  | PersonalTodoApplication.CorruptError
  | ApiNotFoundError
  | Storage.Error

type ProposalApiError =
  | ApiNotFoundError
  | ConflictError
  | InvalidRequestError
  | PersonalTodoProposalStaleRevisionError
  | UnknownError

function proposalError(err: ProposalError, proposalID?: string): Effect.Effect<never, ProposalApiError> {
  if (Schema.is(PersonalTodo.InputError)(err))
    return Effect.fail(new InvalidRequestError({ message: err.message, kind: "personal-todo", field: err.field }))
  if (Schema.is(PersonalTodo.ConflictError)(err))
    return Effect.fail(new ConflictError({ message: err.message, resource: err.id }))
  if (Schema.is(PersonalTodo.StaleRevisionError)(err))
    return Effect.fail(
      new PersonalTodoProposalStaleRevisionError({
        name: "PersonalTodoProposalStaleRevisionError",
        data: {
          proposalID: proposalID ?? err.id,
          todoID: err.id,
          expected: err.expected,
          actual: err.actual,
          message: err.message,
        },
      }),
    )
  if (Schema.is(PersonalTodoProposal.InputError)(err) || Schema.is(PersonalTodoApplication.InputError)(err))
    return Effect.fail(
      new InvalidRequestError({ message: err.message, kind: "personal-todo-proposal", field: err.field }),
    )
  if (Schema.is(PersonalTodoProposal.ConflictError)(err) || Schema.is(PersonalTodoApplication.ConflictError)(err))
    return Effect.fail(new ConflictError({ message: err.message, resource: err.id }))
  if (Schema.is(PersonalTodoApplication.NotFoundError)(err)) return Effect.fail(notFound(err.message))
  if (Schema.is(PersonalTodoApplication.StaleRevisionError)(err))
    return Effect.fail(
      new PersonalTodoProposalStaleRevisionError({
        name: "PersonalTodoProposalStaleRevisionError",
        data: {
          proposalID: proposalID ?? err.id,
          todoID: err.id,
          expected: err.expected,
          ...(err.actual === undefined ? {} : { actual: err.actual }),
          message: err.message,
        },
      }),
    )
  if (Schema.is(PersonalTodoProposal.CorruptError)(err))
    return Effect.fail(new UnknownError({ message: "The saved personal Todo proposal is corrupt.", ref: err.id }))
  if (Schema.is(PersonalTodoApplication.CorruptError)(err))
    return Effect.fail(new UnknownError({ message: "The saved personal Todo application is corrupt.", ref: err.id }))
  if (Schema.is(ApiNotFoundError)(err)) return Effect.fail(err)
  return Effect.fail(new UnknownError({ message: "Personal Todo storage is unavailable." }))
}

function proposalApi<A, E extends ProposalError, R>(self: Effect.Effect<A, E, R>, proposalID?: string) {
  return self.pipe(Effect.catch((err) => proposalError(err, proposalID)))
}

export const personalTodoHandlers = HttpApiBuilder.group(InstanceHttpApi, "raya-personal-todo", (handlers) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const todos = PersonalTodo.make({ storage })
    const proposals = PersonalTodoProposal.make({ storage })
    const applications = PersonalTodoApplication.make({ storage })
    const view = (proposal: PersonalTodoProposal.Info) =>
      applications.receipt(proposal).pipe(
        Effect.map((receipt) => ({
          proposal,
          state: receipt?.state ?? ("open" as const),
          ...(receipt?.state === "applied" ? { todo: receipt.postimage } : {}),
        })),
      )

    return handlers
      .handle("personalTodoList", () => todos.list())
      .handle("personalTodoCreate", (ctx) => api(todos.create(ctx.payload)))
      .handle("personalTodoReminders", () => api(todos.claimReminders()))
      .handle("personalTodoReminderAcknowledge", (ctx) =>
        api(todos.acknowledge(ctx.payload.deliveryID, ctx.payload.claimID)).pipe(
          Effect.flatMap((ack) =>
            ack ? Effect.succeed(ack) : Effect.fail(notFound("Personal todo reminder not found or not due.")),
          ),
        ),
      )
      .handle("personalTodoProposalList", () =>
        proposalApi(proposals.list().pipe(Effect.flatMap((items) => Effect.forEach(items, view)))),
      )
      .handle("personalTodoProposalGet", (ctx) =>
        proposalApi(
          Effect.gen(function* () {
            const item = yield* proposals.get(ctx.params.proposalID)
            if (!item) return yield* notFound("Personal Todo proposal not found.")
            return yield* view(item)
          }),
        ),
      )
      .handle("personalTodoProposalApply", (ctx) =>
        proposalApi(
          Effect.gen(function* () {
            yield* applications.apply(ctx.params.proposalID, ctx.payload.digest)
            const item = yield* proposals.get(ctx.params.proposalID)
            if (!item) return yield* notFound("Personal Todo proposal not found.")
            return yield* view(item)
          }),
          ctx.params.proposalID,
        ),
      )
      .handle("personalTodoProposalReject", (ctx) =>
        proposalApi(
          Effect.gen(function* () {
            yield* applications.reject(ctx.params.proposalID, ctx.payload.digest)
            const item = yield* proposals.get(ctx.params.proposalID)
            if (!item) return yield* notFound("Personal Todo proposal not found.")
            return yield* view(item)
          }),
          ctx.params.proposalID,
        ),
      )
      .handle("personalTodoGet", (ctx) =>
        api(todos.get(ctx.params.todoID)).pipe(
          Effect.flatMap((item) => (item ? Effect.succeed(item) : Effect.fail(notFound("Personal todo not found.")))),
        ),
      )
      .handle(
        "personalTodoUpdate",
        (ctx: { params: { todoID: string }; payload: typeof PersonalTodoUpdatePayload.Type }) =>
          api(todos.update(ctx.params.todoID, ctx.payload)).pipe(
            Effect.flatMap((item) => (item ? Effect.succeed(item) : Effect.fail(notFound("Personal todo not found.")))),
          ),
      )
      .handle("personalTodoDelete", (ctx) =>
        api(todos.remove(ctx.params.todoID, ctx.query.revision)).pipe(
          Effect.flatMap((removed) =>
            removed ? Effect.succeed(true) : Effect.fail(notFound("Personal todo not found.")),
          ),
        ),
      )
  }),
)
