import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { PersonalTodo } from "."
import { PersonalTodoProposal } from "./proposal"

export namespace PersonalTodoApplication {
  const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
  const ID = PersonalTodoProposal.Info.fields.id
  const Pending = Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("pending"),
    proposalID: ID,
    digest: Hash,
    preparedAt: Schema.Number,
    base: Schema.optional(PersonalTodo.Info),
    postimage: PersonalTodo.Info,
  })
  const Applied = Schema.Struct({
    ...Pending.fields,
    state: Schema.Literal("applied"),
  })
  const Rejected = Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("rejected"),
    proposalID: ID,
    digest: Hash,
    rejectedAt: Schema.Number,
  })
  const Receipt = Schema.Union([Pending, Applied, Rejected])
  export type Receipt = typeof Receipt.Type

  export class InputError extends Schema.TaggedErrorClass<InputError>()("PersonalTodoApplicationInputError", {
    field: Schema.Literals(["id", "digest", "time"]),
    message: Schema.String,
  }) {}
  export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PersonalTodoApplicationNotFoundError", {
    id: Schema.String,
    message: Schema.String,
  }) {}
  export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("PersonalTodoApplicationConflictError", {
    id: Schema.String,
    message: Schema.String,
  }) {}
  export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()(
    "PersonalTodoApplicationStaleRevisionError",
    {
      id: Schema.String,
      expected: Schema.Int,
      actual: Schema.optional(Schema.Int),
      message: Schema.String,
    },
  ) {}
  export class CorruptError extends Schema.TaggedErrorClass<CorruptError>()("PersonalTodoApplicationCorruptError", {
    id: Schema.String,
    message: Schema.String,
  }) {}

  type Store = Pick<Storage.Interface, "create" | "read" | "replace" | "update" | "list">
  type Deps = { storage: Store; now?: () => number }
  const prefix = ["raya", "personal-todo-proposal-applies", "v1"]
  const limit = 1_024
  const key = (id: string) => [...prefix, id]

  const optional = <A>(value: A | null | undefined, prior: A | undefined) =>
    value === undefined ? prior : value === null ? undefined : value

  export function make(deps: Deps) {
    const proposals = PersonalTodoProposal.make({ storage: deps.storage })
    const todos = PersonalTodo.make({ storage: deps.storage, now: deps.now })
    const clock = () => {
      const at = deps.now?.() ?? Date.now()
      return Number.isFinite(at) && Math.abs(at) <= 8.64e15
        ? Effect.succeed(at)
        : Effect.fail(
            new InputError({ field: "time", message: "The Todo application clock returned an invalid time." }),
          )
    }
    const read = (id: string) =>
      deps.storage.read<unknown>(key(id)).pipe(
        Effect.flatMap((raw) => {
          const row = typeof raw === "object" && raw !== null ? raw : undefined
          const rejected = row && "state" in row && row.state === "rejected"
          const mixed = rejected
            ? "preparedAt" in row || "base" in row || "postimage" in row
            : Boolean(row && "rejectedAt" in row)
          if (mixed)
            return Effect.fail(
              new CorruptError({ id, message: "The saved Todo application receipt mixes lifecycle fields." }),
            )
          return Schema.decodeUnknownEffect(Receipt)(raw).pipe(
            Effect.mapError(
              () => new CorruptError({ id, message: "The saved Todo application receipt is malformed." }),
            ),
          )
        }),
        Effect.catchIf(
          (err) => Storage.NotFoundError.isInstance(err),
          () => Effect.succeed(undefined),
        ),
      )

    const postimage = Effect.fn("PersonalTodoApplication.postimage")(function* (
      proposal: PersonalTodoProposal.Info,
      base: PersonalTodo.Info | undefined,
      at: number,
    ) {
      if (proposal.target.kind === "existing") {
        if (!base)
          return yield* new StaleRevisionError({
            id: proposal.target.todoID,
            expected: proposal.target.baseRevision,
            message: "The proposed personal Todo no longer exists.",
          })
        if (base.revision !== proposal.target.baseRevision)
          return yield* new StaleRevisionError({
            id: base.id,
            expected: proposal.target.baseRevision,
            actual: base.revision,
            message: "The personal Todo changed before this proposal was applied.",
          })
      }
      if (proposal.target.kind === "new" && base)
        return yield* new ConflictError({
          id: proposal.target.todoID,
          message: "The proposed new personal Todo already exists.",
        })
      const changes = proposal.changes
      const revision = proposal.target.baseRevision + 1
      const createdAt = base?.createdAt ?? at
      const tasks = changes.subtasks
        ? yield* Effect.forEach(changes.subtasks, (input) =>
            Effect.gen(function* () {
              const prior = input.kind === "existing" ? base?.subtasks?.find((item) => item.id === input.id) : undefined
              if (input.kind === "existing" && (!prior || prior.revision !== input.revision))
                return yield* new StaleRevisionError({
                  id: input.id,
                  expected: input.revision,
                  ...(prior ? { actual: prior.revision } : {}),
                  message: "A personal Todo subtask changed before this proposal was applied.",
                })
              if (input.kind === "new" && base?.subtasks?.some((item) => item.id === input.id))
                return yield* new ConflictError({
                  id: input.id,
                  message: "A proposed new personal Todo subtask already exists.",
                })
              const status = input.status ?? prior?.status ?? "open"
              const done = status === "completed"
              const updatedAt = Math.max(at, prior?.updatedAt ?? at)
              const reminder = prior?.reminderAt
              return {
                version: 1 as const,
                id: input.id,
                title: input.title.trim(),
                status,
                done,
                ...(optional(input.notes, prior?.notes) === undefined
                  ? {}
                  : { notes: optional(input.notes, prior?.notes) }),
                ...(optional(input.priority, prior?.priority) === undefined
                  ? {}
                  : { priority: optional(input.priority, prior?.priority) }),
                ...(optional(input.estimateMinutes, prior?.estimateMinutes) === undefined
                  ? {}
                  : { estimateMinutes: optional(input.estimateMinutes, prior?.estimateMinutes) }),
                ...(optional(input.dueAt, prior?.dueAt) === undefined
                  ? {}
                  : { dueAt: optional(input.dueAt, prior?.dueAt) }),
                ...(reminder === undefined ? {} : { reminderAt: reminder, reminderRevision: prior?.reminderRevision }),
                ...(optional(input.links, prior?.links) === undefined
                  ? {}
                  : { links: optional(input.links, prior?.links) }),
                createdAt: prior?.createdAt ?? at,
                updatedAt,
                ...(done ? { completedAt: prior?.completedAt ?? updatedAt } : {}),
                revision: prior ? prior.revision + 1 : 1,
              }
            }),
          )
        : base?.subtasks
      const done = base?.done ?? false
      const reminderAt = optional(changes.reminderAt, base?.reminderAt)
      const result: PersonalTodo.Info = {
        version: 2,
        id: proposal.target.todoID,
        title: (changes.title ?? base?.title ?? "").trim(),
        status: base?.status ?? "open",
        done,
        ...(optional(changes.detail, base?.detail) === undefined
          ? {}
          : { detail: optional(changes.detail, base?.detail) }),
        ...(optional(changes.priority, base?.priority) === undefined
          ? {}
          : { priority: optional(changes.priority, base?.priority) }),
        ...(optional(changes.estimateMinutes, base?.estimateMinutes) === undefined
          ? {}
          : { estimateMinutes: optional(changes.estimateMinutes, base?.estimateMinutes) }),
        ...(optional(changes.dueAt, base?.dueAt) === undefined ? {} : { dueAt: optional(changes.dueAt, base?.dueAt) }),
        ...(reminderAt === undefined ? {} : { reminderAt }),
        ...(reminderAt === undefined
          ? {}
          : changes.reminderAt === undefined
            ? { reminderRevision: base?.reminderRevision ?? revision }
            : { reminderRevision: revision }),
        ...(optional(changes.links, base?.links) === undefined ? {} : { links: optional(changes.links, base?.links) }),
        ...(tasks === undefined ? {} : { subtasks: tasks }),
        createdAt,
        updatedAt: Math.max(at, base?.updatedAt ?? at),
        ...(done ? { completedAt: base?.completedAt ?? Math.max(at, base?.updatedAt ?? at) } : {}),
        revision,
      }
      return yield* Schema.decodeUnknownEffect(PersonalTodo.Info)(result).pipe(
        Effect.mapError(
          () => new CorruptError({ id: proposal.id, message: "The Todo proposal postimage is invalid." }),
        ),
      )
    })

    const verify = Effect.fn("PersonalTodoApplication.verify")(function* (
      proposal: PersonalTodoProposal.Info,
      receipt: Receipt,
    ) {
      if (receipt.proposalID !== proposal.id || receipt.digest !== proposal.digest)
        return yield* new ConflictError({
          id: proposal.id,
          message: "The Todo application receipt has different content.",
        })
      if (receipt.state === "rejected") return receipt
      if ((proposal.target.kind === "new") !== (receipt.base === undefined))
        return yield* new CorruptError({ id: proposal.id, message: "The Todo application receipt base is invalid." })
      const expected = yield* postimage(proposal, receipt.base, receipt.preparedAt)
      if (!isDeepStrictEqual(expected, receipt.postimage))
        return yield* new CorruptError({ id: proposal.id, message: "The Todo application postimage is corrupt." })
      return receipt
    })

    const receipt = Effect.fn("PersonalTodoApplication.receipt")(function* (proposal: PersonalTodoProposal.Info) {
      const saved = yield* read(proposal.id)
      if (!saved) return undefined
      return yield* verify(proposal, saved)
    })

    const load = Effect.fn("PersonalTodoApplication.load")(function* (id: string, digest: string) {
      const proposalID = yield* Schema.decodeUnknownEffect(ID)(id).pipe(
        Effect.mapError(() => new InputError({ field: "id", message: "Use a valid Todo proposal ID." })),
      )
      const expected = yield* Schema.decodeUnknownEffect(Hash)(digest).pipe(
        Effect.mapError(() => new InputError({ field: "digest", message: "Use the exact Todo proposal digest." })),
      )
      const proposal = yield* proposals.get(proposalID)
      if (!proposal) return yield* new NotFoundError({ id: proposalID, message: "The Todo proposal was not found." })
      if (proposal.digest !== expected)
        return yield* new ConflictError({ id: proposalID, message: "The Todo proposal digest changed." })
      return { proposalID, expected, proposal }
    })

    const apply = Effect.fn("PersonalTodoApplication.apply")(function* (id: string, digest: string) {
      const loaded = yield* load(id, digest)
      const proposalID = loaded.proposalID
      const expected = loaded.expected
      const proposal = loaded.proposal
      const saved = yield* read(proposalID)
      const receipt = saved
        ? yield* verify(proposal, saved)
        : yield* Effect.gen(function* () {
            const base = yield* todos.get(proposal.target.todoID)
            const preparedAt = yield* clock()
            const intended = yield* postimage(proposal, base, preparedAt)
            const pending: Receipt = {
              version: 1,
              state: "pending",
              proposalID,
              digest: expected,
              preparedAt,
              ...(base ? { base } : {}),
              postimage: intended,
            }
            if (yield* deps.storage.create(key(proposalID), pending).pipe(Effect.orDie)) return pending
            const raced = yield* read(proposalID)
            if (!raced)
              return yield* new CorruptError({ id: proposalID, message: "The Todo application receipt disappeared." })
            return yield* verify(proposal, raced)
          })
      if (receipt.state === "rejected")
        return yield* new ConflictError({ id: proposalID, message: "The Todo proposal was rejected." })
      if (receipt.state === "applied") return receipt.postimage
      const item = yield* todos
        .applyProposal({
          proposalID,
          digest: expected,
          todoID: proposal.target.todoID,
          baseRevision: proposal.target.baseRevision,
          postimage: receipt.postimage,
        })
        .pipe(
          Effect.mapError((err) => {
            if (err._tag === "PersonalTodoStaleRevisionError")
              return new StaleRevisionError({
                id: err.id,
                expected: err.expected,
                actual: err.actual,
                message: err.message,
              })
            return new ConflictError({ id: proposalID, message: err.message })
          }),
        )
      if (!item)
        return yield* new StaleRevisionError({
          id: proposal.target.todoID,
          expected: proposal.target.baseRevision,
          message: "The proposed personal Todo no longer exists.",
        })
      const applied: Receipt = { ...receipt, state: "applied" }
      yield* deps.storage.replace(key(proposalID), applied).pipe(Effect.orDie)
      return applied.postimage
    })

    const reject = Effect.fn("PersonalTodoApplication.reject")(function* (id: string, digest: string) {
      const loaded = yield* load(id, digest)
      const saved = yield* read(loaded.proposalID)
      if (saved) {
        const prior = yield* verify(loaded.proposal, saved)
        if (prior.state === "rejected") return prior
        return yield* new ConflictError({
          id: loaded.proposalID,
          message: "The Todo proposal is already being applied or was applied.",
        })
      }
      const rejected: Receipt = {
        version: 1,
        state: "rejected",
        proposalID: loaded.proposalID,
        digest: loaded.expected,
        rejectedAt: yield* clock(),
      }
      if (yield* deps.storage.create(key(loaded.proposalID), rejected).pipe(Effect.orDie)) return rejected
      const raced = yield* read(loaded.proposalID)
      if (!raced)
        return yield* new CorruptError({
          id: loaded.proposalID,
          message: "The Todo application receipt disappeared.",
        })
      const prior = yield* verify(loaded.proposal, raced)
      if (prior.state === "rejected") return prior
      return yield* new ConflictError({
        id: loaded.proposalID,
        message: "The Todo proposal is already being applied or was applied.",
      })
    })

    const list = Effect.fn("PersonalTodoApplication.list")(function* () {
      const keys = yield* deps.storage.list(prefix)
      if (keys.length > limit)
        return yield* new CorruptError({ id: "", message: "The Todo application receipt index is too large." })
      const rows: Receipt[] = []
      for (const path of keys) {
        const id = path.at(-1) ?? ""
        if (path.length !== prefix.length + 1 || !Schema.is(ID)(id))
          return yield* new CorruptError({ id, message: "The Todo application receipt key is malformed." })
        const proposal = yield* proposals.get(id)
        if (!proposal) return yield* new CorruptError({ id, message: "The Todo application receipt has no proposal." })
        const saved = yield* read(id)
        if (!saved) return yield* new CorruptError({ id, message: "The indexed Todo application receipt is missing." })
        rows.push(yield* verify(proposal, saved))
      }
      return rows.toSorted((a, b) => {
        const left = a.state === "rejected" ? a.rejectedAt : a.preparedAt
        const right = b.state === "rejected" ? b.rejectedAt : b.preparedAt
        return right - left || a.proposalID.localeCompare(b.proposalID)
      })
    })

    return { apply, list, receipt, reject }
  }
}
