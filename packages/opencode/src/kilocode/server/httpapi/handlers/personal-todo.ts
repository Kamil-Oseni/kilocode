import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { Storage } from "@/storage/storage"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { ConflictError, InvalidRequestError, notFound } from "@/server/routes/instance/httpapi/errors"
import { PersonalTodoStaleRevisionError, PersonalTodoUpdatePayload } from "../groups/personal-todo"

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

export const personalTodoHandlers = HttpApiBuilder.group(InstanceHttpApi, "raya-personal-todo", (handlers) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const todos = PersonalTodo.make({ storage })

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
