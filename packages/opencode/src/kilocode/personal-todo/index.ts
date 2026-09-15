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

  export const MAX_SUBTASKS = 100
  export const MAX_LINKS = 50
  export const MAX_ESTIMATE_MINUTES = 525_600
  export const Status = Schema.Literals(["open", "completed"])
  export type Status = typeof Status.Type
  export const Priority = Schema.Literals(["low", "medium", "high", "urgent"])
  export type Priority = typeof Priority.Type
  const Estimate = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_ESTIMATE_MINUTES))
  export const Link = Schema.Struct({
    kind: Schema.Literals(["chat", "routine", "goal", "session"]),
    id: Text,
  })
  export type Link = typeof Link.Type

  export const Subtask = Schema.Struct({
    version: Schema.Literal(1),
    id: Schema.String,
    title: Text,
    notes: Schema.optional(Detail),
    status: Status,
    done: Schema.Boolean,
    priority: Schema.optional(Priority),
    estimateMinutes: Schema.optional(Estimate),
    dueAt: Schema.optional(Time),
    reminderAt: Schema.optional(Time),
    reminderRevision: Schema.optional(Revision),
    links: Schema.optional(Schema.Array(Link)),
    createdAt: Time,
    updatedAt: Time,
    completedAt: Schema.optional(Time),
    revision: Revision,
  })
  export type Subtask = typeof Subtask.Type

  const V1Info = Schema.Struct({
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
  type V1Info = typeof V1Info.Type

  export const Info = Schema.Struct({
    version: Schema.Literals([1, 2]),
    id: Schema.String,
    title: Text,
    detail: Schema.optional(Detail),
    status: Status,
    done: Schema.Boolean,
    priority: Schema.optional(Priority),
    estimateMinutes: Schema.optional(Estimate),
    dueAt: Schema.optional(Time),
    reminderAt: Schema.optional(Time),
    reminderRevision: Schema.optional(Revision),
    links: Schema.optional(Schema.Array(Link)),
    subtasks: Schema.optional(Schema.Array(Subtask)),
    createdAt: Time,
    updatedAt: Time,
    completedAt: Schema.optional(Time),
    revision: Revision,
  })
  export type Info = typeof Info.Type

  const V2Info = Schema.Struct({
    ...Info.fields,
    version: Schema.Literal(2),
  })
  type V2Info = typeof V2Info.Type

  const ProposalApply = Schema.Struct({
    version: Schema.Literal(1),
    id: Schema.String.check(
      Schema.isPattern(/^proposal_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    ),
    digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  })
  type ProposalApply = typeof ProposalApply.Type
  const StoredV1Info = Schema.Struct({ ...V1Info.fields, proposalApply: Schema.optional(ProposalApply) })
  const StoredV2Info = Schema.Struct({ ...V2Info.fields, proposalApply: Schema.optional(ProposalApply) })
  type StoredInfo = typeof StoredV1Info.Type | typeof StoredV2Info.Type

  const TombstoneFields = {
    id: Schema.String,
    deleted: Schema.Literal(true),
    deletedAt: Time,
    revision: Revision,
  }
  const V1Tombstone = Schema.Struct({
    version: Schema.Literal(1),
    ...TombstoneFields,
    proposalApply: Schema.optional(ProposalApply),
  })
  const V2Tombstone = Schema.Struct({
    version: Schema.Literal(2),
    ...TombstoneFields,
    proposalApply: Schema.optional(ProposalApply),
  })
  const Stored = Schema.Union([StoredV1Info, StoredV2Info, V1Tombstone, V2Tombstone])

  export type Create = {
    title: string
    detail?: string
    dueAt?: number
    reminderAt?: number
    priority?: Priority
    estimateMinutes?: number
    links?: Link[]
  }

  export type Update = {
    revision: number
    title?: string
    detail?: string | null
    done?: boolean
    dueAt?: number | null
    reminderAt?: number | null
    status?: Status
    priority?: Priority | null
    estimateMinutes?: number | null
    links?: Link[] | null
  }

  export type SubtaskInput = {
    id?: string
    revision?: number
    title: string
    notes?: string
    status?: Status
    priority?: Priority
    estimateMinutes?: number
    dueAt?: number
    reminderAt?: number
    links?: Link[]
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
      "notes",
      "dueAt",
      "reminderAt",
      "revision",
      "time",
      "deliveryID",
      "claimID",
      "status",
      "priority",
      "estimateMinutes",
      "links",
      "subtasks",
      "subtaskID",
      "subtaskRevision",
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

  export class SubtaskStaleRevisionError extends Schema.TaggedErrorClass<SubtaskStaleRevisionError>()(
    "PersonalTodoSubtaskStaleRevisionError",
    {
      id: Schema.String,
      subtaskID: Schema.String,
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
    subtaskID?: () => string
  }

  export const REMINDER_LEASE_MS = 300_000
  export const REMINDER_CLAIM_LIMIT = 100
  const prefix = ["raya", "personal-todos", "v1"]
  const reminderPrefix = ["raya", "personal-todo-reminders", "v1", "receipt"]
  const pattern = /^todo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const subtaskPattern = /^subtodo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const deliveryPattern =
    /^(todo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_r([1-9][0-9]*)$/i
  const claimPattern = /^claim_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const key = (id: string) => [...prefix, id]
  const receiptKey = (id: string) => [...reminderPrefix, id]
  const stored = Schema.decodeUnknownEffect(Stored)

  const valid = (value: number) => Number.isFinite(value) && Math.abs(value) <= 8.64e15
  const project = (item: StoredInfo): Info =>
    Schema.decodeUnknownSync(Info)(item.version === 1 ? { ...item, status: item.done ? "completed" : "open" } : item)
  const uniqueLinks = (items: readonly Link[] | undefined) => {
    if (items === undefined) return true
    const keys = items.map((item) => `${item.kind}:${item.id}`)
    return items.length <= MAX_LINKS && new Set(keys).size === keys.length
  }
  const coherent = (item: V2Info) =>
    item.done === (item.status === "completed") &&
    (item.done ? item.completedAt !== undefined : item.completedAt === undefined) &&
    uniqueLinks(item.links) &&
    (item.subtasks?.length ?? 0) <= MAX_SUBTASKS &&
    new Set(item.subtasks?.map((task) => task.id)).size === (item.subtasks?.length ?? 0) &&
    (item.subtasks ?? []).every(
      (task) =>
        subtaskPattern.test(task.id) &&
        task.done === (task.status === "completed") &&
        (task.done ? task.completedAt !== undefined : task.completedAt === undefined) &&
        uniqueLinks(task.links),
    )
  const decodeStored = (input: unknown) => {
    const item = Schema.decodeUnknownSync(Stored)(input)
    if (!("deleted" in item) && item.version === 2 && !coherent(item))
      throw new Error("Personal todo status does not match its compatibility fields.")
    return item
  }

  export function make(deps: Deps) {
    const now = () => deps.now?.() ?? Date.now()
    const identify = () => deps.id?.() ?? `todo_${randomUUID()}`
    const identifySubtask = () => deps.subtaskID?.() ?? `subtodo_${randomUUID()}`
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
    const subtaskIdentity = (id: string) =>
      subtaskPattern.test(id)
        ? Effect.succeed(id)
        : Effect.fail(new InputError({ field: "subtaskID", message: "Use a valid personal todo subtask ID." }))
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
    const estimate = (value: number | undefined | null) => {
      if (value === undefined || value === null) return Effect.succeed(undefined)
      if (Number.isSafeInteger(value) && value >= 1 && value <= MAX_ESTIMATE_MINUTES) return Effect.succeed(value)
      return Effect.fail(
        new InputError({
          field: "estimateMinutes",
          message: `Use an estimate from 1 to ${MAX_ESTIMATE_MINUTES} minutes.`,
        }),
      )
    }
    const priority = (value: unknown) => {
      if (value === undefined || value === null) return Effect.succeed(value)
      return Schema.decodeUnknownEffect(Priority)(value).pipe(
        Effect.mapError(() => new InputError({ field: "priority", message: "Use a valid personal Todo priority." })),
      )
    }
    const status = (value: unknown) => {
      if (value === undefined) return Effect.succeed(undefined)
      return Schema.decodeUnknownEffect(Status)(value).pipe(
        Effect.mapError(() => new InputError({ field: "status", message: "Use a valid personal Todo status." })),
      )
    }
    const links = (value: Link[] | undefined | null) => {
      if (value === undefined || value === null) return Effect.succeed(undefined)
      if (value.length > MAX_LINKS)
        return Effect.fail(new InputError({ field: "links", message: `Use no more than ${MAX_LINKS} links.` }))
      return Schema.decodeUnknownEffect(Schema.Array(Link))(value).pipe(
        Effect.mapError(() => new InputError({ field: "links", message: "Use valid personal Todo links." })),
        Effect.flatMap((items) => {
          return uniqueLinks(items)
            ? Effect.succeed(items)
            : Effect.fail(new InputError({ field: "links", message: "Personal Todo links must be unique." }))
        }),
      )
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
          if (!("deleted" in item) && item.version === 2 && !coherent(item))
            return Effect.die(new Error("Personal todo status does not match its compatibility fields."))
          return "deleted" in item ? Effect.succeed(undefined) : Effect.succeed(project(item))
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
      const length = yield* estimate(input.estimateMinutes)
      const refs = yield* links(input.links)
      const level = yield* priority(input.priority)
      const extended = input.priority !== undefined || input.estimateMinutes !== undefined || input.links !== undefined
      const base = {
        id,
        title: yield* title(input.title),
        done: false,
        createdAt: at,
        updatedAt: at,
        revision: 1,
      }
      const fields = {
        ...(notes === undefined ? {} : { detail: notes }),
        ...(date === undefined ? {} : { dueAt: date }),
        ...(alert === undefined ? {} : { reminderAt: alert, reminderRevision: 1 }),
      }
      const item: V1Info | V2Info = extended
        ? {
            version: 2,
            ...base,
            ...fields,
            status: "open",
            ...(level === undefined || level === null ? {} : { priority: level }),
            ...(length === undefined ? {} : { estimateMinutes: length }),
            ...(refs === undefined ? {} : { links: refs }),
          }
        : { version: 1, ...base, ...fields }
      if (yield* deps.storage.create(key(id), item).pipe(Effect.orDie)) return project(item)
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
      const length = input.estimateMinutes === undefined ? undefined : yield* estimate(input.estimateMinutes)
      const refs = input.links === undefined ? undefined : yield* links(input.links)
      const phase = yield* status(input.status)
      const level = yield* priority(input.priority)
      if (phase !== undefined && input.done !== undefined && (phase === "completed") !== input.done)
        return yield* new InputError({ field: "status", message: "Status and done must describe the same state." })
      const state: { actual?: number; missing?: boolean } = {}
      const raw = yield* deps.storage
        .update<Record<string, unknown>>(key(id), (draft) => {
          const prior = decodeStored(draft)
          if ("deleted" in prior) {
            state.missing = true
            return
          }
          if (prior.revision !== expected || prior.revision === Number.MAX_SAFE_INTEGER) {
            state.actual = prior.revision
            return
          }
          const extended =
            prior.version === 2 ||
            input.status !== undefined ||
            input.priority !== undefined ||
            input.estimateMinutes !== undefined ||
            input.links !== undefined
          const done = input.done ?? (phase === undefined ? prior.done : phase === "completed")
          const stamp = Math.max(at, prior.updatedAt)
          const next = prior.revision + 1
          const common = {
            id: prior.id,
            title: name ?? prior.title,
            done,
            ...((input.detail === null ? undefined : (notes ?? prior.detail)) === undefined
              ? {}
              : { detail: input.detail === null ? undefined : (notes ?? prior.detail) }),
            ...((input.dueAt === null ? undefined : (date ?? prior.dueAt)) === undefined
              ? {}
              : { dueAt: input.dueAt === null ? undefined : (date ?? prior.dueAt) }),
            ...((input.reminderAt === null ? undefined : (alert ?? prior.reminderAt)) === undefined
              ? {}
              : { reminderAt: input.reminderAt === null ? undefined : (alert ?? prior.reminderAt) }),
            ...((input.reminderAt === null ? undefined : alert === undefined ? prior.reminderRevision : next) ===
            undefined
              ? {}
              : { reminderRevision: alert === undefined ? prior.reminderRevision : next }),
            createdAt: prior.createdAt,
            updatedAt: stamp,
            ...(done ? { completedAt: prior.completedAt ?? stamp } : {}),
            revision: next,
            ...(prior.proposalApply === undefined ? {} : { proposalApply: prior.proposalApply }),
          }
          const item: V1Info | V2Info = extended
            ? {
                version: 2,
                ...common,
                status: done ? "completed" : "open",
                ...((input.priority === null
                  ? undefined
                  : (level ?? (prior.version === 2 ? prior.priority : undefined))) === undefined
                  ? {}
                  : { priority: level ?? (prior.version === 2 ? prior.priority : undefined) }),
                ...((input.estimateMinutes === null
                  ? undefined
                  : (length ?? (prior.version === 2 ? prior.estimateMinutes : undefined))) === undefined
                  ? {}
                  : { estimateMinutes: length ?? (prior.version === 2 ? prior.estimateMinutes : undefined) }),
                ...((input.links === null ? undefined : (refs ?? (prior.version === 2 ? prior.links : undefined))) ===
                undefined
                  ? {}
                  : { links: refs ?? (prior.version === 2 ? prior.links : undefined) }),
                ...(prior.version === 2 && prior.subtasks !== undefined ? { subtasks: prior.subtasks } : {}),
              }
            : { version: 1, ...common }
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
      if (raw === undefined) return undefined
      const item = yield* stored(raw).pipe(Effect.orDie)
      return "deleted" in item ? undefined : project(item)
    })

    const prepare = Effect.fn("PersonalTodo.prepareSubtask")(function* (
      parent: string,
      input: SubtaskInput,
      prior: Subtask | undefined,
      at: number,
    ) {
      const id = yield* subtaskIdentity(input.id ?? identifySubtask())
      if (prior) {
        if (input.revision === undefined)
          return yield* new InputError({
            field: "subtaskRevision",
            message: "Use the exact current revision for an existing personal Todo subtask.",
          })
        const expected = yield* revision(input.revision)
        if (expected !== prior.revision)
          return yield* new SubtaskStaleRevisionError({
            id: parent,
            subtaskID: id,
            expected,
            actual: prior.revision,
            message: "The personal Todo subtask changed before this replacement.",
          })
      }
      if (!prior && input.revision !== undefined)
        return yield* new InputError({
          field: "subtaskRevision",
          message: "A new personal Todo subtask cannot have an existing revision.",
        })
      const phase = (yield* status(input.status)) ?? prior?.status ?? "open"
      const notes = yield* detail(input.notes)
      const level = yield* priority(input.priority)
      const length = yield* estimate(input.estimateMinutes)
      const date = yield* due(input.dueAt)
      const alert = yield* reminder(input.reminderAt)
      const refs = yield* links(input.links)
      const next = prior ? prior.revision + 1 : 1
      if (prior?.revision === Number.MAX_SAFE_INTEGER)
        return yield* new SubtaskStaleRevisionError({
          id: parent,
          subtaskID: id,
          expected: prior.revision,
          actual: prior.revision,
          message: "The personal Todo subtask revision cannot advance.",
        })
      const done = phase === "completed"
      const stamp = Math.max(at, prior?.updatedAt ?? at)
      const task: Subtask = {
        version: 1,
        id,
        title: yield* title(input.title),
        status: phase,
        done,
        ...(notes === undefined ? {} : { notes }),
        ...(level === undefined || level === null ? {} : { priority: level }),
        ...(length === undefined ? {} : { estimateMinutes: length }),
        ...(date === undefined ? {} : { dueAt: date }),
        ...(alert === undefined ? {} : { reminderAt: alert }),
        ...(alert === undefined
          ? prior?.reminderAt === undefined
            ? {}
            : {}
          : { reminderRevision: prior?.reminderAt === alert ? (prior.reminderRevision ?? next) : next }),
        ...(refs === undefined ? {} : { links: refs }),
        createdAt: prior?.createdAt ?? at,
        updatedAt: stamp,
        ...(done ? { completedAt: prior?.completedAt ?? stamp } : {}),
        revision: next,
      }
      const before = prior
        ? JSON.stringify({
            title: prior.title,
            notes: prior.notes,
            status: prior.status,
            priority: prior.priority,
            estimateMinutes: prior.estimateMinutes,
            dueAt: prior.dueAt,
            reminderAt: prior.reminderAt,
            links: prior.links,
          })
        : undefined
      const after = JSON.stringify({
        title: task.title,
        notes: task.notes,
        status: task.status,
        priority: task.priority,
        estimateMinutes: task.estimateMinutes,
        dueAt: task.dueAt,
        reminderAt: task.reminderAt,
        links: task.links,
      })
      if (before === after && prior) return prior
      return task
    })

    const replaceSubtasks = Effect.fn("PersonalTodo.replaceSubtasks")(function* (
      id: string,
      input: { revision: number; subtasks: SubtaskInput[] },
    ) {
      yield* identity(id)
      const expected = yield* revision(input.revision)
      if (input.subtasks.length > MAX_SUBTASKS)
        return yield* new InputError({ field: "subtasks", message: `Use no more than ${MAX_SUBTASKS} subtasks.` })
      const at = yield* clock()
      const current = yield* read(id)
      if (!current) return undefined
      if (current.revision !== expected || current.revision === Number.MAX_SAFE_INTEGER)
        return yield* new StaleRevisionError({
          id,
          operation: "update",
          expected,
          actual: current.revision,
          message: "The personal todo changed before this subtask replacement.",
        })
      const saved = new Map((current.subtasks ?? []).map((task) => [task.id, task]))
      const seen = new Set<string>()
      const tasks: Subtask[] = []
      for (const item of input.subtasks) {
        if (item.id !== undefined) yield* subtaskIdentity(item.id)
        const prior = item.id === undefined ? undefined : saved.get(item.id)
        if (item.id !== undefined && !prior)
          return yield* new InputError({ field: "subtaskID", message: "The personal Todo subtask was not found." })
        const task = yield* prepare(id, item, prior, at)
        if (seen.has(task.id))
          return yield* new InputError({ field: "subtasks", message: "Personal Todo subtask IDs must be unique." })
        seen.add(task.id)
        tasks.push(task)
      }
      const state: { actual?: number; missing?: boolean } = {}
      const raw = yield* deps.storage
        .update<Record<string, unknown>>(key(id), (draft) => {
          const prior = decodeStored(draft)
          if ("deleted" in prior) {
            state.missing = true
            return
          }
          if (prior.revision !== expected || prior.revision === Number.MAX_SAFE_INTEGER) {
            state.actual = prior.revision
            return
          }
          const done = prior.done
          const next: typeof StoredV2Info.Type = {
            ...project(prior),
            version: 2,
            status: done ? "completed" : "open",
            subtasks: tasks,
            updatedAt: Math.max(at, prior.updatedAt),
            revision: prior.revision + 1,
            ...(prior.proposalApply === undefined ? {} : { proposalApply: prior.proposalApply }),
          }
          for (const field of Object.keys(draft)) delete draft[field]
          Object.assign(draft, next)
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
          message: "The personal todo changed before this subtask replacement.",
        })
      if (raw === undefined || state.missing) return undefined
      const item = yield* stored(raw).pipe(Effect.orDie)
      return "deleted" in item ? undefined : project(item)
    })

    const changeSubtask = Effect.fn("PersonalTodo.changeSubtask")(function* (
      id: string,
      input: { revision: number; subtaskID: string; subtaskRevision: number; status: Status },
    ) {
      yield* identity(id)
      yield* subtaskIdentity(input.subtaskID)
      const expected = yield* revision(input.revision)
      const childExpected = yield* revision(input.subtaskRevision)
      const phase = yield* status(input.status)
      if (phase === undefined)
        return yield* new InputError({ field: "status", message: "Use a valid personal Todo subtask status." })
      const at = yield* clock()
      const state: { actual?: number; child?: number; missing?: boolean } = {}
      const raw = yield* deps.storage
        .update<Record<string, unknown>>(key(id), (draft) => {
          const prior = decodeStored(draft)
          if ("deleted" in prior) {
            state.missing = true
            return
          }
          if (prior.revision !== expected || prior.revision === Number.MAX_SAFE_INTEGER) {
            state.actual = prior.revision
            return
          }
          if (prior.version !== 2) {
            state.missing = true
            return
          }
          const index = prior.subtasks?.findIndex((task) => task.id === input.subtaskID) ?? -1
          if (index < 0) {
            state.missing = true
            return
          }
          const task = prior.subtasks?.[index]
          if (!task) {
            state.missing = true
            return
          }
          if (task.revision !== childExpected || task.revision === Number.MAX_SAFE_INTEGER) {
            state.child = task.revision
            return
          }
          const done = phase === "completed"
          const changed: Subtask = {
            ...task,
            status: phase,
            done,
            updatedAt: Math.max(at, task.updatedAt),
            ...(done ? { completedAt: task.completedAt ?? Math.max(at, task.updatedAt) } : { completedAt: undefined }),
            revision: task.revision + 1,
          }
          const tasks = [...(prior.subtasks ?? [])]
          tasks[index] = changed
          const next: V2Info = {
            ...prior,
            subtasks: tasks,
            updatedAt: Math.max(at, prior.updatedAt),
            revision: prior.revision + 1,
          }
          for (const field of Object.keys(draft)) delete draft[field]
          Object.assign(draft, next)
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
          message: "The personal todo changed before this subtask update.",
        })
      if (state.child !== undefined)
        return yield* new SubtaskStaleRevisionError({
          id,
          subtaskID: input.subtaskID,
          expected: childExpected,
          actual: state.child,
          message: "The personal Todo subtask changed before this update.",
        })
      if (raw === undefined || state.missing) return undefined
      const item = yield* stored(raw).pipe(Effect.orDie)
      return "deleted" in item ? undefined : project(item)
    })

    const completeSubtask = (id: string, input: Omit<Parameters<typeof changeSubtask>[1], "status">) =>
      changeSubtask(id, { ...input, status: "completed" })
    const reopenSubtask = (id: string, input: Omit<Parameters<typeof changeSubtask>[1], "status">) =>
      changeSubtask(id, { ...input, status: "open" })

    const remove = Effect.fn("PersonalTodo.remove")(function* (id: string, expected: number) {
      yield* identity(id)
      yield* revision(expected)
      const at = yield* clock()
      const state: { actual?: number; missing?: boolean } = {}
      const raw = yield* deps.storage
        .update<Record<string, unknown>>(key(id), (draft) => {
          const prior = decodeStored(draft)
          if ("deleted" in prior) {
            state.missing = true
            return
          }
          if (prior.revision !== expected || prior.revision === Number.MAX_SAFE_INTEGER) {
            state.actual = prior.revision
            return
          }
          for (const field of Object.keys(draft)) delete draft[field]
          const base = {
            id,
            deleted: true,
            deletedAt: Math.max(at, prior.updatedAt),
            revision: prior.revision + 1,
          } as const
          const tombstone: typeof V1Tombstone.Type | typeof V2Tombstone.Type =
            prior.version === 1
              ? { version: 1, ...base, ...(prior.proposalApply ? { proposalApply: prior.proposalApply } : {}) }
              : { version: 2, ...base, ...(prior.proposalApply ? { proposalApply: prior.proposalApply } : {}) }
          Object.assign(draft, tombstone)
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

    const applyProposal = Effect.fn("PersonalTodo.applyProposal")(function* (input: {
      proposalID: string
      digest: string
      todoID: string
      baseRevision: number
      postimage: Info
    }) {
      yield* identity(input.todoID)
      const marker = yield* Schema.decodeUnknownEffect(ProposalApply)({
        version: 1,
        id: input.proposalID,
        digest: input.digest,
      }).pipe(Effect.orDie)
      const postimage = yield* Schema.decodeUnknownEffect(V2Info)(input.postimage).pipe(Effect.orDie)
      if (!coherent(postimage) || postimage.id !== input.todoID || postimage.revision !== input.baseRevision + 1)
        return yield* new InputError({ field: "revision", message: "The Todo proposal postimage is invalid." })
      const marked = (item: { proposalApply?: ProposalApply }) =>
        item.proposalApply?.id === marker.id && item.proposalApply.digest === marker.digest
      if (input.baseRevision === 0) {
        if (yield* deps.storage.create(key(input.todoID), { ...postimage, proposalApply: marker }).pipe(Effect.orDie))
          return postimage
        const raw = yield* deps.storage.read<unknown>(key(input.todoID)).pipe(Effect.orDie)
        const prior = decodeStored(raw)
        if (prior.proposalApply?.id === marker.id && prior.proposalApply.digest === marker.digest) return postimage
        return yield* new ConflictError({ id: input.todoID, message: "The proposed new personal Todo already exists." })
      }
      const state: { actual?: number; item?: Info; missing?: boolean } = {}
      const raw = yield* deps.storage
        .update<Record<string, unknown>>(key(input.todoID), (draft) => {
          const prior = decodeStored(draft)
          if (marked(prior)) {
            state.item = postimage
            return
          }
          if ("deleted" in prior) {
            state.missing = true
            return
          }
          if (prior.revision !== input.baseRevision || prior.revision === Number.MAX_SAFE_INTEGER) {
            state.actual = prior.revision
            return
          }
          for (const field of Object.keys(draft)) delete draft[field]
          Object.assign(draft, postimage, { proposalApply: marker })
        })
        .pipe(
          Effect.catchIf(
            (err) => Storage.NotFoundError.isInstance(err),
            () => Effect.succeed(undefined),
          ),
          Effect.orDie,
        )
      if (state.item) return state.item
      if (state.actual !== undefined)
        return yield* new StaleRevisionError({
          id: input.todoID,
          operation: "update",
          expected: input.baseRevision,
          actual: state.actual,
          message: "The personal todo changed before this proposal was applied.",
        })
      if (raw === undefined || state.missing) return undefined
      const saved = decodeStored(raw)
      return "deleted" in saved ? undefined : project(saved)
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

    return {
      create,
      get,
      list,
      update,
      replaceSubtasks,
      completeSubtask,
      reopenSubtask,
      applyProposal,
      remove,
      claimReminders,
      acknowledge,
    }
  }
}
