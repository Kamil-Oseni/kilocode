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
    reminderAt: Schema.optional(Time),
    reminderRevision: Schema.optional(Revision),
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
    reminderAt?: number
  }

  export type Update = {
    revision: number
    title?: string
    detail?: string | null
    done?: boolean
    dueAt?: number | null
    reminderAt?: number | null
  }

  export const Reminder = Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("claimed"),
    deliveryID: Schema.String,
    claimID: Schema.String,
    todoID: Schema.String,
    todoRevision: Revision,
    reminderRevision: Revision,
    title: Text,
    reminderAt: Time,
    claimedAt: Time,
    claimExpiresAt: Time,
  })
  export type Reminder = typeof Reminder.Type

  export const ReminderAck = Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("acknowledged"),
    deliveryID: Schema.String,
    claimID: Schema.String,
    todoID: Schema.String,
    todoRevision: Revision,
    reminderRevision: Revision,
    acknowledgedAt: Time,
  })
  export type ReminderAck = typeof ReminderAck.Type
  const ReminderReceipt = Schema.Union([Reminder, ReminderAck])

  export class InputError extends Schema.TaggedErrorClass<InputError>()("PersonalTodoInputError", {
    field: Schema.Literals([
      "id",
      "title",
      "detail",
      "dueAt",
      "reminderAt",
      "revision",
      "time",
      "deliveryID",
      "claimID",
    ]),
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
    claim?: () => string
  }

  export const REMINDER_LEASE_MS = 300_000
  export const REMINDER_CLAIM_LIMIT = 100
  const prefix = ["raya", "personal-todos", "v1"]
  const reminderPrefix = ["raya", "personal-todo-reminders", "v1", "receipt"]
  const pattern = /^todo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const deliveryPattern =
    /^(todo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_r([1-9][0-9]*)$/i
  const claimPattern = /^claim_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const key = (id: string) => [...prefix, id]
  const receiptKey = (id: string) => [...reminderPrefix, id]
  const decode = Schema.decodeUnknownEffect(Info)
  const stored = Schema.decodeUnknownEffect(Stored)

  const valid = (value: number) => Number.isFinite(value) && Math.abs(value) <= 8.64e15

  export function make(deps: Deps) {
    const now = () => deps.now?.() ?? Date.now()
    const identify = () => deps.id?.() ?? `todo_${randomUUID()}`
    const claimID = () => deps.claim?.() ?? `claim_${randomUUID()}`
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
    const reminder = (value: number | undefined | null) => {
      if (value === undefined || value === null) return Effect.succeed(undefined)
      if (valid(value)) return Effect.succeed(value)
      return Effect.fail(new InputError({ field: "reminderAt", message: "Use a valid reminder time." }))
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
      const notes = yield* detail(input.detail)
      const date = yield* due(input.dueAt)
      const alert = yield* reminder(input.reminderAt)
      const item: Info = {
        version: 1,
        id,
        title: yield* title(input.title),
        done: false,
        createdAt: at,
        updatedAt: at,
        revision: 1,
      }
      if (notes !== undefined) item.detail = notes
      if (date !== undefined) item.dueAt = date
      if (alert !== undefined) {
        item.reminderAt = alert
        item.reminderRevision = 1
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
      const alert = input.reminderAt === undefined ? undefined : yield* reminder(input.reminderAt)
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
          const next = prior.revision + 1
          const item: Info = {
            ...prior,
            title: name ?? prior.title,
            done,
            updatedAt: stamp,
            revision: next,
          }
          if (input.detail === null) delete item.detail
          if (notes !== undefined) item.detail = notes
          if (input.dueAt === null) delete item.dueAt
          if (date !== undefined) item.dueAt = date
          if (input.reminderAt === null) {
            delete item.reminderAt
            delete item.reminderRevision
          }
          if (alert !== undefined) {
            item.reminderAt = alert
            item.reminderRevision = next
          }
          if (done) item.completedAt = prior.completedAt ?? stamp
          if (!done) delete item.completedAt
          for (const field of Object.keys(draft)) delete draft[field]
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

    const reserve = Effect.fn("PersonalTodo.reserveReminder")(function* (item: Info, at: number) {
      const deliveryID = `${item.id}_r${item.reminderRevision}`
      const claim: Reminder = {
        version: 1,
        state: "claimed",
        deliveryID,
        claimID: claimID(),
        todoID: item.id,
        todoRevision: item.revision,
        reminderRevision: item.reminderRevision!,
        title: item.title,
        reminderAt: item.reminderAt!,
        claimedAt: at,
        claimExpiresAt: Math.min(8.64e15, at + REMINDER_LEASE_MS),
      }
      if (yield* deps.storage.create(receiptKey(deliveryID), claim).pipe(Effect.orDie)) return claim
      const state: { claim?: Reminder } = {}
      yield* deps.storage
        .update<Record<string, unknown>>(receiptKey(deliveryID), (draft) => {
          const prior = Schema.decodeUnknownSync(ReminderReceipt)(draft)
          if (prior.state === "acknowledged" || prior.claimExpiresAt >= at) return
          for (const field of Object.keys(draft)) delete draft[field]
          Object.assign(draft, claim)
          state.claim = claim
        })
        .pipe(Effect.orDie)
      return state.claim
    })

    const claimReminders = Effect.fn("PersonalTodo.claimReminders")(function* () {
      const at = yield* clock()
      const items = (yield* list())
        .filter(
          (item) =>
            !item.done && item.reminderAt !== undefined && item.reminderRevision !== undefined && item.reminderAt <= at,
        )
        .toSorted((a, b) => a.reminderAt! - b.reminderAt! || a.id.localeCompare(b.id))
      const rows: Reminder[] = []
      for (const item of items) {
        if (rows.length >= REMINDER_CLAIM_LIMIT) break
        const claim = yield* reserve(item, at)
        if (!claim) continue
        const current = yield* read(item.id)
        if (
          !current ||
          current.done ||
          current.reminderRevision !== item.reminderRevision ||
          current.reminderAt === undefined ||
          current.reminderAt > at
        )
          continue
        rows.push({ ...claim, title: current.title, todoRevision: current.revision, reminderAt: current.reminderAt })
      }
      return rows
    })

    const acknowledge = Effect.fn("PersonalTodo.acknowledge")(function* (deliveryID: string, claim: string) {
      const match = deliveryPattern.exec(deliveryID)
      if (!match)
        return yield* new InputError({ field: "deliveryID", message: "Use a valid personal todo reminder ID." })
      yield* identity(match[1])
      yield* revision(Number(match[2]))
      if (!claimPattern.test(claim))
        return yield* new InputError({ field: "claimID", message: "Use a valid personal todo reminder claim ID." })
      const at = yield* clock()
      const state: { ack?: ReminderAck } = {}
      yield* deps.storage
        .update<Record<string, unknown>>(receiptKey(deliveryID), (draft) => {
          const prior = Schema.decodeUnknownSync(ReminderReceipt)(draft)
          if (prior.state === "acknowledged") {
            if (prior.claimID === claim) state.ack = prior
            return
          }
          if (prior.claimID !== claim || prior.claimExpiresAt < at) return
          const ack: ReminderAck = {
            version: 1,
            state: "acknowledged",
            deliveryID,
            claimID: claim,
            todoID: prior.todoID,
            todoRevision: prior.todoRevision,
            reminderRevision: prior.reminderRevision,
            acknowledgedAt: at,
          }
          for (const field of Object.keys(draft)) delete draft[field]
          Object.assign(draft, ack)
          state.ack = ack
        })
        .pipe(
          Effect.catchIf(
            (err) => Storage.NotFoundError.isInstance(err),
            () => Effect.succeed(undefined),
          ),
          Effect.orDie,
        )
      return state.ack
    })

    return { create, get, list, update, remove, claimReminders, acknowledge }
  }
}
