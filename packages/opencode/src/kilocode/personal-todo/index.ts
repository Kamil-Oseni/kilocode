import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"

export namespace PersonalTodo {
  const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(500))
  const Detail = Schema.String.check(Schema.isMaxLength(10_000))
  const Time = Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }))
  const Revision = Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  )

  export const Info = Schema.Struct({
    version: Schema.Literal(1),
    id: Schema.String,
    title: Text,
    detail: Schema.optional(Detail),
    done: Schema.Boolean,
    dueAt: Schema.optional(Time),
    createdAt: Time,
    updatedAt: Time,
    completedAt: Schema.optional(Time),
    revision: Revision,
  })
  export type Info = typeof Info.Type

  const Tombstone = Schema.Struct({
    version: Schema.Literal(1),
    id: Schema.String,
    deleted: Schema.Literal(true),
    deletedAt: Time,
    revision: Revision,
  })
  const Stored = Schema.Union([Info, Tombstone])

  export type Create = {
    title: string
    detail?: string
    dueAt?: number
  }

  export type Update = {
    revision: number
    title?: string
    detail?: string | null
    done?: boolean
    dueAt?: number | null
  }

  export class InputError extends Schema.TaggedErrorClass<InputError>()("PersonalTodoInputError", {
    field: Schema.Literals(["id", "title", "detail", "dueAt", "revision", "time"]),
    message: Schema.String,
  }) {}

  export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("PersonalTodoConflictError", {
    id: Schema.String,
    message: Schema.String,
  }) {}

  export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()(
    "PersonalTodoStaleRevisionError",
    {
      id: Schema.String,
      operation: Schema.Literals(["update", "delete"]),
      expected: Revision,
      actual: Revision,
      message: Schema.String,
    },
  ) {}

  type Store = Pick<Storage.Interface, "create" | "list" | "read" | "update">
  type Deps = {
    storage: Store
    now?: () => number
    id?: () => string
  }

  const prefix = ["raya", "personal-todos", "v1"]
  const pattern = /^todo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const key = (id: string) => [...prefix, id]
  const decode = Schema.decodeUnknownEffect(Info)
  const stored = Schema.decodeUnknownEffect(Stored)

  const valid = (value: number) => Number.isFinite(value) && Math.abs(value) <= 8.64e15

  export function make(deps: Deps) {
    const now = () => deps.now?.() ?? Date.now()
    const identify = () => deps.id?.() ?? `todo_${randomUUID()}`
    const identity = (id: string) =>
      pattern.test(id)
        ? Effect.succeed(id)
        : Effect.fail(new InputError({ field: "id", message: "Use a valid personal todo ID." }))
    const title = (value: string) => {
      const text = value.trim()
      return text.length > 0 && text.length <= 500
        ? Effect.succeed(text)
        : Effect.fail(new InputError({ field: "title", message: "Use a title between 1 and 500 characters." }))
    }
    const detail = (value: string | undefined | null) => {
      if (value === undefined || value === null) return Effect.succeed(undefined)
      if (value.length <= 10_000) return Effect.succeed(value)
      return Effect.fail(new InputError({ field: "detail", message: "Use details no longer than 10,000 characters." }))
    }
    const due = (value: number | undefined | null) => {
      if (value === undefined || value === null) return Effect.succeed(undefined)
      if (valid(value)) return Effect.succeed(value)
      return Effect.fail(new InputError({ field: "dueAt", message: "Use a valid due date." }))
    }
    const revision = (value: number) =>
      Number.isSafeInteger(value) && value >= 1
        ? Effect.succeed(value)
        : Effect.fail(new InputError({ field: "revision", message: "Use a valid personal todo revision." }))
    const clock = () => {
      const at = now()
      return valid(at)
        ? Effect.succeed(at)
        : Effect.fail(new InputError({ field: "time", message: "The todo clock returned an invalid time." }))
    }
    const read = (id: string) =>
      deps.storage.read<unknown>(key(id)).pipe(
        Effect.flatMap(stored),
        Effect.flatMap((item) => {
          if (item.id !== id) return Effect.die(new Error("Personal todo identity does not match its storage key."))
          return "deleted" in item ? Effect.succeed(undefined) : Effect.succeed(item)
        }),
        Effect.catchIf(
          (err) => Storage.NotFoundError.isInstance(err),
          () => Effect.succeed(undefined),
        ),
        Effect.orDie,
      )

    const get = Effect.fn("PersonalTodo.get")(function* (id: string) {
      yield* identity(id)
      return yield* read(id)
    })

    const list = Effect.fn("PersonalTodo.list")(function* () {
      const paths = yield* deps.storage.list(prefix).pipe(Effect.orDie)
      const items = yield* Effect.forEach(
        paths,
        (path) => {
          const id = path.at(-1) ?? ""
          return identity(id).pipe(Effect.flatMap(read), Effect.orDie)
        },
        { concurrency: 4 },
      )
      return items
        .filter((item) => item !== undefined)
        .toSorted((a, b) => Number(a.done) - Number(b.done) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    })

    const create = Effect.fn("PersonalTodo.create")(function* (input: Create) {
      const id = yield* identity(identify())
      const at = yield* clock()
      const item: Info = {
        version: 1,
        id,
        title: yield* title(input.title),
        detail: yield* detail(input.detail),
        done: false,
        dueAt: yield* due(input.dueAt),
        createdAt: at,
        updatedAt: at,
        revision: 1,
      }
      if (yield* deps.storage.create(key(id), item).pipe(Effect.orDie)) return item
      return yield* new ConflictError({ id, message: "A personal todo with this ID already exists." })
    })

    const update = Effect.fn("PersonalTodo.update")(function* (id: string, input: Update) {
      yield* identity(id)
      const expected = yield* revision(input.revision)
      const at = yield* clock()
      const name = input.title === undefined ? undefined : yield* title(input.title)
      const notes = input.detail === undefined ? undefined : yield* detail(input.detail)
      const date = input.dueAt === undefined ? undefined : yield* due(input.dueAt)
      const state: { actual?: number; missing?: boolean } = {}
      const raw = yield* deps.storage
        .update<Record<string, unknown>>(key(id), (draft) => {
          const prior = Schema.decodeUnknownSync(Stored)(draft)
          if ("deleted" in prior) {
            state.missing = true
            return
          }
          if (prior.revision !== expected || prior.revision === Number.MAX_SAFE_INTEGER) {
            state.actual = prior.revision
            return
          }
          const done = input.done ?? prior.done
          const stamp = Math.max(at, prior.updatedAt)
          const item: Info = {
            ...prior,
            title: name ?? prior.title,
            detail: input.detail === null ? undefined : (notes ?? prior.detail),
            done,
            dueAt: input.dueAt === null ? undefined : (date ?? prior.dueAt),
            updatedAt: stamp,
            completedAt: done ? (prior.completedAt ?? stamp) : undefined,
            revision: prior.revision + 1,
          }
          Object.assign(draft, item)
        })
        .pipe(
          Effect.catchIf(
            (err) => Storage.NotFoundError.isInstance(err),
            () => Effect.succeed(undefined),
          ),
          Effect.orDie,
        )
      if (state.actual !== undefined)
        return yield* new StaleRevisionError({
          id,
          operation: "update",
          expected,
          actual: state.actual,
          message: "The personal todo changed before this update.",
        })
      if (state.missing) return undefined
      return raw === undefined ? undefined : yield* decode(raw).pipe(Effect.orDie)
    })

    const remove = Effect.fn("PersonalTodo.remove")(function* (id: string, expected: number) {
      yield* identity(id)
      yield* revision(expected)
      const at = yield* clock()
      const state: { actual?: number; missing?: boolean } = {}
      const raw = yield* deps.storage
        .update<Record<string, unknown>>(key(id), (draft) => {
          const prior = Schema.decodeUnknownSync(Stored)(draft)
          if ("deleted" in prior) {
            state.missing = true
            return
          }
          if (prior.revision !== expected || prior.revision === Number.MAX_SAFE_INTEGER) {
            state.actual = prior.revision
            return
          }
          for (const field of Object.keys(draft)) delete draft[field]
          Object.assign(draft, {
            version: 1,
            id,
            deleted: true,
            deletedAt: Math.max(at, prior.updatedAt),
            revision: prior.revision + 1,
          } satisfies typeof Tombstone.Type)
        })
        .pipe(
          Effect.catchIf(
            (err) => Storage.NotFoundError.isInstance(err),
            () => Effect.succeed(undefined),
          ),
          Effect.orDie,
        )
      if (state.actual !== undefined)
        return yield* new StaleRevisionError({
          id,
          operation: "delete",
          expected,
          actual: state.actual,
          message: "The personal todo changed before this deletion.",
        })
      if (raw === undefined || state.missing) return false
      return true
    })

    return { create, get, list, update, remove }
  }
}
