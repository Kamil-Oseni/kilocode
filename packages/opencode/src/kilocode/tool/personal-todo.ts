import { Effect, Schema } from "effect"
import { PersonalTodo } from "@/kilocode/personal-todo"
import type { Storage } from "@/storage/storage"
import * as Tool from "@/tool/tool"
import { request } from "./schedule-request"

const ID = Schema.String.annotate({ description: "Stable todo ID returned by an earlier list, get, or mutation." })
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
  description: "Exact current revision returned by an earlier list, get, or mutation.",
})
const Text = Schema.String.annotate({ description: "A concise todo title." })
const Detail = Schema.NullOr(Schema.String).annotate({
  description: "Replacement notes, or null to clear existing notes.",
})
const Time = Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }))
const Due = Schema.NullOr(Time).annotate({
  description: "Replacement due time as Unix epoch milliseconds, or null to clear it.",
})
const Reminder = Schema.NullOr(Time).annotate({
  description: "Replacement reminder time as Unix epoch milliseconds, or null to clear it.",
})

const Parameters = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literal("get"), id: ID }),
  Schema.Struct({
    action: Schema.Literal("create"),
    title: Text,
    detail: Schema.optional(Schema.String),
    dueAt: Schema.optional(Time),
    reminderAt: Schema.optional(Time),
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    id: ID,
    revision: Revision,
    title: Schema.optional(Text),
    detail: Schema.optional(Detail),
    dueAt: Schema.optional(Due),
    reminderAt: Schema.optional(Reminder),
  }),
  Schema.Struct({ action: Schema.Literals(["complete", "reopen"]), id: ID, revision: Revision }),
  Schema.Struct({ action: Schema.Literal("delete"), id: ID, revision: Revision }),
])

type Params = typeof Parameters.Type

type Meta = {
  action: Params["action"]
  status: "complete" | "missing" | "conflict" | "invalid"
  id?: string
  revision?: number
  expectedRevision?: number
  actualRevision?: number
}

const result = (title: string, body: unknown, metadata: Meta) => ({
  title,
  output: JSON.stringify(body),
  metadata,
})

export function personalTodoTool(input: { storage: Storage.Interface }) {
  const todos = PersonalTodo.make(input)

  return Tool.define(
    "personal_todo",
    Effect.succeed({
      description:
        "Manage the user's durable personal Todo list. Actions: list, get, create, update, complete, reopen, and delete. List or get first and pass the exact returned revision for every change or deletion; never guess a revision or retry a conflict automatically. Use ask_options before creating or expanding an item when the user's title, due time, reminder time, scope, or intended breakdown is materially ambiguous. Before setting a due time or reminder, use ask_options if the user's local date, local time, or timezone is missing or ambiguous, then resolve it to exact Unix epoch milliseconds before mutation. Create only one reviewed item per call. When a broad goal could become several subtasks, present suggested subtasks to the user for review instead of silently creating them. This tool updates personal planning state only; it does not start agents or perform the work in a Todo.",
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const items = yield* todos.list()
            return result(
              "Personal todos",
              { status: "complete", items },
              { action: params.action, status: "complete" },
            )
          }

          if (params.action === "get") {
            const item = yield* todos.get(params.id)
            if (!item)
              return result(
                "Personal todo not found",
                { status: "missing", id: params.id },
                { action: params.action, status: "missing", id: params.id },
              )
            return result(
              "Personal todo",
              { status: "complete", item },
              { action: params.action, status: "complete", id: item.id, revision: item.revision },
            )
          }

          if (
            params.action === "update" &&
            params.title === undefined &&
            params.detail === undefined &&
            params.dueAt === undefined &&
            params.reminderAt === undefined
          )
            return result(
              "Personal todo unchanged",
              {
                status: "invalid",
                id: params.id,
                message: "Provide at least one title, detail, dueAt, or reminderAt change.",
              },
              { action: params.action, status: "invalid", id: params.id },
            )

          if (params.action === "create") {
            return yield* request(
              input.storage,
              ctx,
              params,
              ctx
                .ask({
                  permission: "personal_todo",
                  patterns: [params.action],
                  always: [params.action],
                  metadata: params,
                })
                .pipe(
                  Effect.andThen(
                    todos.create({
                      title: params.title,
                      detail: params.detail,
                      dueAt: params.dueAt,
                      reminderAt: params.reminderAt,
                    }),
                  ),
                  Effect.map((item) =>
                    result(
                      "Personal todo created",
                      { status: "complete", item },
                      { action: params.action, status: "complete", id: item.id, revision: item.revision },
                    ),
                  ),
                ),
              {
                title: "Personal Todo request needs review",
                changed:
                  "This tool call previously used different Todo instructions. Review the earlier item before creating another Todo.",
                pending:
                  "The earlier Todo creation may have succeeded, but its result could not be confirmed. Review Personal Todos before retrying; do not create a replacement Todo.",
                metadata: { action: params.action, status: "invalid" },
              },
            )
          }

          yield* ctx.ask({
            permission: "personal_todo",
            patterns: [params.action],
            always: [params.action],
            metadata: params,
          })

          if (params.action === "delete") {
            const removed = yield* todos.remove(params.id, params.revision)
            if (!removed)
              return result(
                "Personal todo not found",
                { status: "missing", id: params.id },
                { action: params.action, status: "missing", id: params.id },
              )
            return result(
              "Personal todo deleted",
              { status: "complete", id: params.id, deleted: true },
              { action: params.action, status: "complete", id: params.id, revision: params.revision + 1 },
            )
          }

          const patch =
            params.action === "update"
              ? {
                  revision: params.revision,
                  title: params.title,
                  detail: params.detail,
                  dueAt: params.dueAt,
                  reminderAt: params.reminderAt,
                }
              : { revision: params.revision, done: params.action === "complete" }
          const item = yield* todos.update(params.id, patch)
          if (!item)
            return result(
              "Personal todo not found",
              { status: "missing", id: params.id },
              { action: params.action, status: "missing", id: params.id },
            )
          return result(
            params.action === "complete"
              ? "Personal todo completed"
              : params.action === "reopen"
                ? "Personal todo reopened"
                : "Personal todo updated",
            { status: "complete", item },
            { action: params.action, status: "complete", id: item.id, revision: item.revision },
          )
        }).pipe(
          Effect.catch((err) => {
            if (err._tag === "PersonalTodoStaleRevisionError")
              return todos.get(err.id).pipe(
                Effect.map((latest) =>
                  result(
                    "Personal todo changed",
                    {
                      status: "conflict",
                      id: err.id,
                      operation: err.operation,
                      expectedRevision: err.expected,
                      actualRevision: err.actual,
                      latest,
                    },
                    {
                      action: params.action,
                      status: "conflict",
                      id: err.id,
                      expectedRevision: err.expected,
                      actualRevision: err.actual,
                      revision: latest?.revision,
                    },
                  ),
                ),
              )
            if (err._tag === "PersonalTodoInputError" || err._tag === "PersonalTodoConflictError")
              return Effect.succeed(
                result(
                  "Personal todo needs review",
                  { status: "invalid", message: err.message },
                  { action: params.action, status: "invalid", ...("id" in err ? { id: err.id } : {}) },
                ),
              )
            return Effect.fail(err)
          }),
        ),
    }),
  )
}
