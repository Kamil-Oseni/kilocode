import { Effect } from "effect"
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

function proposalApi<A, R>(
  self: Effect.Effect<
    A,
    | PersonalTodoProposal.InputError
    | PersonalTodoProposal.ConflictError
    | PersonalTodoProposal.CorruptError
    | PersonalTodoApplication.InputError
    | PersonalTodoApplication.NotFoundError
    | PersonalTodoApplication.ConflictError
    | PersonalTodoApplication.StaleRevisionError
    | PersonalTodoApplication.CorruptError
    | ApiNotFoundError,
    R
  >,
  proposalID?: string,
) {
  return self.pipe(
    Effect.catchTags({
      PersonalTodoProposalInputError: (err) =>
        Effect.fail(
          new InvalidRequestError({ message: err.message, kind: "personal-todo-proposal", field: err.field }),
        ),
      PersonalTodoApplicationInputError: (err) =>
        Effect.fail(
          new InvalidRequestError({ message: err.message, kind: "personal-todo-proposal", field: err.field }),
        ),
      PersonalTodoProposalConflictError: (err) =>
        Effect.fail(new ConflictError({ message: err.message, resource: err.id })),
      PersonalTodoApplicationConflictError: (err) =>
        Effect.fail(new ConflictError({ message: err.message, resource: err.id })),
      PersonalTodoApplicationNotFoundError: (err) => Effect.fail(notFound(err.message)),
      PersonalTodoApplicationStaleRevisionError: (err) =>
        Effect.fail(
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
        ),
      PersonalTodoProposalCorruptError: (err) =>
        Effect.fail(new UnknownError({ message: "The saved personal Todo proposal is corrupt.", ref: err.id })),
      PersonalTodoApplicationCorruptError: (err) =>
        Effect.fail(new UnknownError({ message: "The saved personal Todo application is corrupt.", ref: err.id })),
    }),
  )
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
          proposals
            .get(ctx.params.proposalID)
            .pipe(
              Effect.flatMap((item) =>
                item ? view(item) : Effect.fail(notFound("Personal Todo proposal not found.")),
              ),
            ),
        ),
      )
      .handle("personalTodoProposalApply", (ctx) =>
        proposalApi(
          applications.apply(ctx.params.proposalID, ctx.payload.digest).pipe(
            Effect.andThen(proposals.get(ctx.params.proposalID)),
            Effect.flatMap((item) => (item ? view(item) : Effect.fail(notFound("Personal Todo proposal not found.")))),
          ),
          ctx.params.proposalID,
        ),
      )
      .handle("personalTodoProposalReject", (ctx) =>
        proposalApi(
          applications.reject(ctx.params.proposalID, ctx.payload.digest).pipe(
            Effect.andThen(proposals.get(ctx.params.proposalID)),
            Effect.flatMap((item) => (item ? view(item) : Effect.fail(notFound("Personal Todo proposal not found.")))),
          ),
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
