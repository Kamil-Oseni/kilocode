import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { PersonalTodoApplication } from "@/kilocode/personal-todo/application"
import { PersonalTodoProposal } from "@/kilocode/personal-todo/proposal"
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
const Priority = Schema.NullOr(PersonalTodo.Priority)
const Estimate = Schema.NullOr(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(PersonalTodo.MAX_ESTIMATE_MINUTES)),
)
const Links = Schema.NullOr(Schema.Array(PersonalTodo.Link).check(Schema.isMaxLength(PersonalTodo.MAX_LINKS)))
const Child = {
  title: Text,
  notes: Schema.optional(Detail),
  status: Schema.optional(PersonalTodo.Status),
  priority: Schema.optional(Priority),
  estimateMinutes: Schema.optional(Estimate),
  dueAt: Schema.optional(Due),
  links: Schema.optional(Links),
}
const ProposedSubtask = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new"), ...Child }),
  Schema.Struct({ kind: Schema.Literal("existing"), id: Schema.String, revision: Revision, ...Child }),
])
const ProposalChanges = Schema.Struct({
  title: Schema.optional(Text),
  detail: Schema.optional(Detail),
  dueAt: Schema.optional(Due),
  reminderAt: Schema.optional(Reminder),
  priority: Schema.optional(Priority),
  estimateMinutes: Schema.optional(Estimate),
  links: Schema.optional(Links),
  subtasks: Schema.optional(Schema.Array(ProposedSubtask).check(Schema.isMaxLength(PersonalTodo.MAX_SUBTASKS))),
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
  Schema.Struct({
    action: Schema.Literal("propose"),
    target: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("new") }),
      Schema.Struct({ kind: Schema.Literal("existing"), id: ID, revision: Revision }),
    ]),
    changes: ProposalChanges,
  }),
  Schema.Struct({
    action: Schema.Literal("apply_proposal"),
    proposalID: Schema.String,
    digest: Schema.String,
  }),
])

type Params = typeof Parameters.Type

type Meta = {
  action: Params["action"]
  status: "complete" | "missing" | "conflict" | "invalid"
  id?: string
  revision?: number
  expectedRevision?: number
  actualRevision?: number
  proposalID?: string
  digest?: string
  view?: "personal-todo-proposal"
}

const result = (title: string, body: unknown, metadata: Meta) => ({
  title,
  output: JSON.stringify(body),
  metadata,
})

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const uuid = (value: string) => {
  const hex = hash(value).slice(0, 32).split("")
  hex[12] = "4"
  hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`
}

export function personalTodoTool(input: { storage: Storage.Interface }) {
  const todos = PersonalTodo.make(input)
  const proposals = PersonalTodoProposal.make(input)
  const applications = PersonalTodoApplication.make(input)

  return Tool.define(
    "personal_todo",
    Effect.succeed({
      description:
        "Manage the user's durable personal Todo list. Actions: list, get, create, update, complete, reopen, delete, propose, and apply_proposal. List or get first and pass the exact returned revision for every existing item or subtask; never guess a revision or retry a conflict automatically. Use ask_options before proposing when the user's title, due time, reminder time, priority, estimate, scope, constraints, or intended breakdown is materially ambiguous. Before setting a due time or reminder, use ask_options if the user's local date, local time, or timezone is missing or ambiguous, then resolve it to exact Unix epoch milliseconds before mutation. Create only one reviewed item per call. Propose returns one reviewable plan and never changes Todos. Call apply_proposal only after the user explicitly reviews that exact proposal; it accepts only the returned proposal ID and digest. Never silently create several top-level Todos from a broad goal. This tool updates personal planning state only; it does not start agents or perform the work in a Todo.",
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

          if (params.action === "propose") {
            if (!ctx.callID)
              return result(
                "Personal Todo proposal needs review",
                { status: "invalid", message: "Todo proposals require a stable tool call." },
                { action: params.action, status: "invalid", view: "personal-todo-proposal" },
              )
            if (params.target.kind === "existing") {
              const item = yield* todos.get(params.target.id)
              if (!item)
                return result(
                  "Personal todo not found",
                  { status: "missing", id: params.target.id },
                  {
                    action: params.action,
                    status: "missing",
                    id: params.target.id,
                    view: "personal-todo-proposal",
                  },
                )
              if (item.revision !== params.target.revision)
                return result(
                  "Personal Todo proposal is stale",
                  {
                    status: "conflict",
                    id: item.id,
                    expectedRevision: params.target.revision,
                    actualRevision: item.revision,
                    latest: item,
                  },
                  {
                    action: params.action,
                    status: "conflict",
                    id: item.id,
                    expectedRevision: params.target.revision,
                    actualRevision: item.revision,
                    revision: item.revision,
                    view: "personal-todo-proposal",
                  },
                )
            }
            const seed = JSON.stringify([ctx.sessionID, ctx.messageID, ctx.callID])
            const target =
              params.target.kind === "new"
                ? { kind: "new" as const, todoID: `todo_${uuid(`${seed}:todo`)}`, baseRevision: 0 as const }
                : {
                    kind: "existing" as const,
                    todoID: params.target.id,
                    baseRevision: params.target.revision,
                  }
            const subtasks = params.changes.subtasks?.map((task, index) =>
              task.kind === "new" ? { ...task, id: `subtodo_${uuid(`${seed}:subtask:${index}`)}` } : task,
            )
            const item = yield* proposals.propose({
              id: `proposal_${uuid(`${seed}:proposal`)}`,
              source: { sessionID: ctx.sessionID, messageID: ctx.messageID, callID: ctx.callID },
              target,
              changes: { ...params.changes, ...(subtasks === undefined ? {} : { subtasks }) },
            })
            const proposal = Schema.decodeUnknownSync(PersonalTodoProposal.Info)(item)
            return result(
              "Personal Todo proposal ready for review",
              { status: "complete", proposal },
              {
                action: params.action,
                status: "complete",
                proposalID: proposal.id,
                digest: proposal.digest,
                view: "personal-todo-proposal",
              },
            )
          }

          if (params.action === "apply_proposal") {
            yield* ctx.ask({
              permission: "personal_todo",
              patterns: [params.action],
              always: [params.action],
              metadata: params,
            })
            const item = yield* applications.apply(params.proposalID, params.digest)
            return result(
              "Personal Todo proposal applied",
              { status: "complete", item, proposalID: params.proposalID, digest: params.digest },
              {
                action: params.action,
                status: "complete",
                id: item.id,
                revision: item.revision,
                proposalID: params.proposalID,
                digest: params.digest,
                view: "personal-todo-proposal",
              },
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
            if (err._tag === "PersonalTodoProposalConflictError" || err._tag === "PersonalTodoApplicationConflictError")
              return Effect.succeed(
                result(
                  "Personal Todo proposal changed",
                  { status: "conflict", message: err.message },
                  {
                    action: params.action,
                    status: "conflict",
                    ...(params.action === "apply_proposal"
                      ? { proposalID: params.proposalID, digest: params.digest }
                      : {}),
                    view: "personal-todo-proposal",
                  },
                ),
              )
            if (err._tag === "PersonalTodoApplicationStaleRevisionError")
              return Effect.succeed(
                result(
                  "Personal Todo proposal is stale",
                  {
                    status: "conflict",
                    message: err.message,
                    expectedRevision: err.expected,
                    actualRevision: err.actual,
                  },
                  {
                    action: params.action,
                    status: "conflict",
                    id: err.id,
                    expectedRevision: err.expected,
                    actualRevision: err.actual,
                    ...(params.action === "apply_proposal"
                      ? { proposalID: params.proposalID, digest: params.digest }
                      : {}),
                    view: "personal-todo-proposal",
                  },
                ),
              )
            if (
              err._tag === "PersonalTodoProposalInputError" ||
              err._tag === "PersonalTodoProposalCorruptError" ||
              err._tag === "PersonalTodoApplicationInputError" ||
              err._tag === "PersonalTodoApplicationCorruptError" ||
              err._tag === "PersonalTodoApplicationNotFoundError"
            )
              return Effect.succeed(
                result(
                  "Personal Todo proposal needs review",
                  {
                    status: err._tag === "PersonalTodoApplicationNotFoundError" ? "missing" : "invalid",
                    message: err.message,
                  },
                  {
                    action: params.action,
                    status: err._tag === "PersonalTodoApplicationNotFoundError" ? "missing" : "invalid",
                    ...("id" in err ? { id: err.id } : {}),
                    ...(params.action === "apply_proposal"
                      ? { proposalID: params.proposalID, digest: params.digest }
                      : {}),
                    view: "personal-todo-proposal",
                  },
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
