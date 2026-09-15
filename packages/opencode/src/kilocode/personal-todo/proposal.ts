import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { PersonalTodo } from "."
import { Storage } from "@/storage/storage"

export namespace PersonalTodoProposal {
  const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(500))
  const Detail = Schema.String.check(Schema.isMaxLength(10_000))
  const Time = Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }))
  const Revision = Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  )
  const SourceID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
  const ProposalID = Schema.String.check(
    Schema.isPattern(/^proposal_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  )
  const TodoID = Schema.String.check(
    Schema.isPattern(/^todo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  )
  const SubtodoID = Schema.String.check(
    Schema.isPattern(/^subtodo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  )
  const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
  const Estimate = Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PersonalTodo.MAX_ESTIMATE_MINUTES),
  )

  export const Source = Schema.Struct({
    sessionID: SourceID,
    messageID: SourceID,
    callID: SourceID,
  })
  export type Source = typeof Source.Type

  export const Target = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("existing"), todoID: TodoID, baseRevision: Revision }),
    Schema.Struct({ kind: Schema.Literal("new"), todoID: TodoID, baseRevision: Schema.Literal(0) }),
  ])
  export type Target = typeof Target.Type

  const Child = {
    id: SubtodoID,
    title: Text,
    status: Schema.optional(PersonalTodo.Status),
  }
  const ChildLinks = Schema.Array(PersonalTodo.Link).check(Schema.isMaxLength(PersonalTodo.MAX_LINKS))
  export const Subtask = Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("new"),
      ...Child,
      priority: Schema.optional(PersonalTodo.Priority),
      estimateMinutes: Schema.optional(Estimate),
      dueAt: Schema.optional(Time),
      notes: Schema.optional(Detail),
      links: Schema.optional(ChildLinks),
    }),
    Schema.Struct({
      kind: Schema.Literal("existing"),
      ...Child,
      revision: Revision,
      priority: Schema.optional(Schema.NullOr(PersonalTodo.Priority)),
      estimateMinutes: Schema.optional(Schema.NullOr(Estimate)),
      dueAt: Schema.optional(Schema.NullOr(Time)),
      notes: Schema.optional(Schema.NullOr(Detail)),
      links: Schema.optional(Schema.NullOr(ChildLinks)),
    }),
  ])
  export type Subtask = typeof Subtask.Type

  export const Changes = Schema.Struct({
    title: Schema.optional(Text),
    detail: Schema.optional(Schema.NullOr(Detail)),
    dueAt: Schema.optional(Schema.NullOr(Time)),
    reminderAt: Schema.optional(Schema.NullOr(Time)),
    priority: Schema.optional(Schema.NullOr(PersonalTodo.Priority)),
    estimateMinutes: Schema.optional(Schema.NullOr(Estimate)),
    links: Schema.optional(
      Schema.NullOr(Schema.Array(PersonalTodo.Link).check(Schema.isMaxLength(PersonalTodo.MAX_LINKS))),
    ),
    subtasks: Schema.optional(Schema.Array(Subtask).check(Schema.isMaxLength(100))),
  })
  export type Changes = typeof Changes.Type

  export const Info = Schema.Struct({
    version: Schema.Literal(1),
    id: ProposalID,
    digest: Hash,
    createdAt: Time,
    source: Source,
    target: Target,
    changes: Changes,
  })
  export type Info = typeof Info.Type

  export type Input = {
    id: string
    source: Source
    target: Target
    changes: Changes
  }

  export class InputError extends Schema.TaggedErrorClass<InputError>()("PersonalTodoProposalInputError", {
    field: Schema.Literals(["id", "source", "target", "changes", "subtasks", "time"]),
    message: Schema.String,
  }) {}

  export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("PersonalTodoProposalConflictError", {
    id: Schema.String,
    message: Schema.String,
  }) {}

  export class CorruptError extends Schema.TaggedErrorClass<CorruptError>()("PersonalTodoProposalCorruptError", {
    id: Schema.String,
    message: Schema.String,
  }) {}

  type Store = Pick<Storage.Interface, "create" | "list" | "read">
  type Deps = { storage: Store; now?: () => number }
  const prefix = ["raya", "personal-todo-proposals", "v1"]
  const key = (id: string) => [...prefix, id]
  const decode = Schema.decodeUnknownEffect(Info)

  const field = (value: unknown) => (value === undefined ? [0] : [1, value])
  const body = (value: Omit<Info, "digest">) =>
    JSON.stringify([
      value.version,
      value.id,
      value.createdAt,
      [value.source.sessionID, value.source.messageID, value.source.callID],
      value.target.kind === "new"
        ? ["new", value.target.todoID, value.target.baseRevision]
        : ["existing", value.target.todoID, value.target.baseRevision],
      [
        field(value.changes.title),
        field(value.changes.detail),
        field(value.changes.dueAt),
        field(value.changes.reminderAt),
        field(value.changes.priority),
        field(value.changes.estimateMinutes),
        field(value.changes.links?.map((item) => [item.kind, item.id])),
        field(
          value.changes.subtasks?.map((item) => [
            item.kind,
            item.id,
            item.kind === "existing" ? item.revision : 0,
            item.title,
            field(item.notes),
            field(item.status),
            field(item.priority),
            field(item.estimateMinutes),
            field(item.dueAt),
            field(item.links?.map((link) => [link.kind, link.id]) ?? item.links),
          ]),
        ),
      ],
    ])
  const request = (value: Pick<Info, "id" | "source" | "target" | "changes">) =>
    JSON.stringify([
      value.id,
      [value.source.sessionID, value.source.messageID, value.source.callID],
      value.target.kind === "new"
        ? ["new", value.target.todoID, value.target.baseRevision]
        : ["existing", value.target.todoID, value.target.baseRevision],
      [
        field(value.changes.title),
        field(value.changes.detail),
        field(value.changes.dueAt),
        field(value.changes.reminderAt),
        field(value.changes.priority),
        field(value.changes.estimateMinutes),
        field(value.changes.links?.map((item) => [item.kind, item.id])),
        field(
          value.changes.subtasks?.map((item) => [
            item.kind,
            item.id,
            item.kind === "existing" ? item.revision : 0,
            item.title,
            field(item.notes),
            field(item.status),
            field(item.priority),
            field(item.estimateMinutes),
            field(item.dueAt),
            field(item.links?.map((link) => [link.kind, link.id]) ?? item.links),
          ]),
        ),
      ],
    ])

  export function seal(value: Omit<Info, "digest">) {
    return createHash("sha256").update(body(value), "utf8").digest("hex")
  }

  export function make(deps: Deps) {
    const invalid = (field: InputError["field"], message: string) => new InputError({ field, message })
    const parse = (id: string, value: unknown) =>
      decode(value).pipe(
        Effect.mapError(() => new CorruptError({ id, message: "The saved Todo proposal is malformed." })),
        Effect.flatMap((item) => {
          if (item.id !== id)
            return new CorruptError({ id, message: "The saved Todo proposal identity does not match its key." })
          if (item.digest !== seal(item))
            return new CorruptError({ id, message: "The saved Todo proposal digest is invalid." })
          return Effect.succeed(item)
        }),
      )
    const read = (id: string) =>
      deps.storage.read<unknown>(key(id)).pipe(
        Effect.flatMap((value) => parse(id, value)),
        Effect.catchIf(
          (err) => Storage.NotFoundError.isInstance(err),
          () => Effect.succeed(undefined),
        ),
      )
    const validate = (input: Input) =>
      Schema.decodeUnknownEffect(Schema.Struct({ id: ProposalID, source: Source, target: Target, changes: Changes }))(
        input,
      ).pipe(
        Effect.mapError(() => invalid("changes", "Use a valid Todo proposal.")),
        Effect.flatMap((value) => {
          if (value.target.kind === "new" && value.changes.title === undefined)
            return invalid("changes", "A new Todo proposal requires a title.")
          if (
            value.target.kind === "new" &&
            (value.changes.detail === null ||
              value.changes.dueAt === null ||
              value.changes.reminderAt === null ||
              value.changes.priority === null ||
              value.changes.estimateMinutes === null ||
              value.changes.links === null)
          )
            return invalid("changes", "Clear values are only valid for an existing Todo.")
          if (value.target.kind === "new" && value.changes.subtasks?.some((item) => item.kind === "existing"))
            return invalid("subtasks", "A new Todo proposal can contain only new subtasks.")
          if (
            value.target.kind === "existing" &&
            value.changes.title === undefined &&
            value.changes.detail === undefined &&
            value.changes.dueAt === undefined &&
            value.changes.reminderAt === undefined &&
            value.changes.priority === undefined &&
            value.changes.estimateMinutes === undefined &&
            value.changes.links === undefined &&
            value.changes.subtasks === undefined
          )
            return invalid("changes", "An existing Todo proposal requires at least one change.")
          const ids = value.changes.subtasks?.map((item) => item.id) ?? []
          if (new Set(ids).size !== ids.length) return invalid("subtasks", "Todo proposal subtask IDs must be unique.")
          const links = value.changes.links ?? []
          if (new Set(links.map((item) => `${item.kind}:${item.id}`)).size !== links.length)
            return invalid("changes", "Todo proposal links must be unique.")
          for (const task of value.changes.subtasks ?? []) {
            const refs = task.links ?? []
            if (new Set(refs.map((item) => `${item.kind}:${item.id}`)).size !== refs.length)
              return invalid("subtasks", "Todo proposal subtask links must be unique.")
          }
          return Effect.succeed(value)
        }),
      )

    const get = Effect.fn("PersonalTodoProposal.get")(function* (id: string) {
      const parsed = yield* Schema.decodeUnknownEffect(ProposalID)(id).pipe(
        Effect.mapError(() => invalid("id", "Use a valid Todo proposal ID.")),
      )
      return yield* read(parsed)
    })

    const list = Effect.fn("PersonalTodoProposal.list")(function* () {
      const keys = yield* deps.storage.list(prefix)
      const rows: Info[] = []
      for (const path of keys) {
        const id = path.at(-1) ?? ""
        if (path.length !== prefix.length + 1 || !Schema.is(ProposalID)(id))
          return yield* new CorruptError({ id, message: "The Todo proposal storage key is malformed." })
        const item = yield* read(id)
        if (!item) return yield* new CorruptError({ id, message: "The indexed Todo proposal is missing." })
        rows.push(item)
      }
      return rows.toSorted((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    })

    const propose = Effect.fn("PersonalTodoProposal.propose")(function* (input: Input) {
      const value = yield* validate(input)
      const prior = yield* read(value.id)
      if (prior) {
        if (request(prior) === request(value)) return prior
        return yield* new ConflictError({
          id: value.id,
          message: "This Todo proposal ID is already bound to different content.",
        })
      }
      const createdAt = deps.now?.() ?? Date.now()
      if (!Number.isFinite(createdAt) || Math.abs(createdAt) > 8.64e15)
        return yield* invalid("time", "The Todo proposal clock returned an invalid time.")
      const draft = {
        version: 1 as const,
        id: value.id,
        createdAt,
        source: value.source,
        target: value.target,
        changes: value.changes,
      }
      const item: Info = { ...draft, digest: seal(draft) }
      if (yield* deps.storage.create(key(item.id), item)) return item
      const raced = yield* read(item.id)
      if (raced && request(raced) === request(item)) return raced
      return yield* new ConflictError({
        id: item.id,
        message: "This Todo proposal ID is already bound to different content.",
      })
    })

    return { get, list, propose }
  }
}
