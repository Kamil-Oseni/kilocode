import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { InvalidRequestError, ApiNotFoundError, ConflictError } from "@/server/routes/instance/httpapi/errors"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"

const root = "/raya/personal-todos"

export const PersonalTodoPaths = {
  list: root,
  item: `${root}/:todoID`,
  reminders: `${root}/reminders/claim`,
  acknowledge: `${root}/reminders/acknowledge`,
} as const

export const PersonalTodoCreatePayload = Schema.Struct({
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  dueAt: Schema.optional(Schema.Number),
  reminderAt: Schema.optional(Schema.Number),
})

export const PersonalTodoUpdatePayload = Schema.Struct({
  revision: Schema.Number,
  title: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.NullOr(Schema.String)),
  done: Schema.optional(Schema.Boolean),
  dueAt: Schema.optional(Schema.NullOr(Schema.Number)),
  reminderAt: Schema.optional(Schema.NullOr(Schema.Number)),
})

export const PersonalTodoReminderAckPayload = Schema.Struct({ deliveryID: Schema.String, claimID: Schema.String })

export const PersonalTodoDeleteQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  revision: Schema.Number,
})

export class PersonalTodoStaleRevisionError extends Schema.ErrorClass<PersonalTodoStaleRevisionError>(
  "PersonalTodoStaleRevisionError",
)(
  {
    name: Schema.Literal("PersonalTodoStaleRevisionError"),
    data: Schema.Struct({
      id: Schema.String,
      operation: Schema.Literals(["update", "delete"]),
      expected: Schema.Number,
      actual: Schema.Number,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 409 },
) {}

const errors = [InvalidRequestError, ApiNotFoundError, ConflictError, PersonalTodoStaleRevisionError] as const

export const PersonalTodoApi = HttpApi.make("raya-personal-todo").add(
  HttpApiGroup.make("raya-personal-todo")
    .add(
      HttpApiEndpoint.get("personalTodoList", PersonalTodoPaths.list, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(PersonalTodo.Info), "Personal todos"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.personalTodo.list",
          summary: "List personal todos",
          description: "List durable personal todos, with open items first.",
        }),
      ),
      HttpApiEndpoint.post("personalTodoCreate", PersonalTodoPaths.list, {
        query: WorkspaceRoutingQuery,
        payload: PersonalTodoCreatePayload,
        success: described(PersonalTodo.Info, "Created personal todo"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.personalTodo.create",
          summary: "Create a personal todo",
          description: "Create one durable personal todo without starting agent work.",
        }),
      ),
      HttpApiEndpoint.post("personalTodoReminders", PersonalTodoPaths.reminders, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(PersonalTodo.Reminder), "Due personal todo reminders"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.personalTodo.reminders",
          summary: "Claim due personal todo reminders",
          description: "Atomically claim up to 100 due local reminders with restart-safe delivery leases.",
        }),
      ),
      HttpApiEndpoint.post("personalTodoReminderAcknowledge", PersonalTodoPaths.acknowledge, {
        query: WorkspaceRoutingQuery,
        payload: PersonalTodoReminderAckPayload,
        success: described(PersonalTodo.ReminderAck, "Acknowledged personal todo reminder"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.personalTodo.acknowledgeReminder",
          summary: "Acknowledge a personal todo reminder",
          description: "Durably suppress an exact reminder delivery after local presentation.",
        }),
      ),
      HttpApiEndpoint.get("personalTodoGet", PersonalTodoPaths.item, {
        params: { todoID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(PersonalTodo.Info, "Personal todo"),
        error: errors,
      }).annotateMerge(OpenApi.annotations({ identifier: "raya.personalTodo.get", summary: "Get a personal todo" })),
      HttpApiEndpoint.patch("personalTodoUpdate", PersonalTodoPaths.item, {
        params: { todoID: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: PersonalTodoUpdatePayload,
        success: described(PersonalTodo.Info, "Updated personal todo"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.personalTodo.update",
          summary: "Update a personal todo",
          description: "Update the exact retained revision of a personal todo.",
        }),
      ),
      HttpApiEndpoint.delete("personalTodoDelete", PersonalTodoPaths.item, {
        params: { todoID: Schema.String },
        query: PersonalTodoDeleteQuery,
        success: described(Schema.Boolean, "Deleted personal todo"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.personalTodo.delete",
          summary: "Delete a personal todo",
          description: "Delete the exact retained revision of a personal todo.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
