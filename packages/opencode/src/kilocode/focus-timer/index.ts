import { Effect, Schema } from "effect"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { Storage } from "@/storage/storage"

export namespace FocusTimer {
  export const MIN_DURATION_MS = 60_000
  export const MAX_DURATION_MS = 86_400_000

  const Time = Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }))
  const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_DURATION_MS))
  const Duration = Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(MIN_DURATION_MS),
    Schema.isLessThanOrEqualTo(MAX_DURATION_MS),
  )
  const Revision = Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  )
  const State = Schema.Literals(["idle", "running", "paused", "completed"])

  const Stored = Schema.Struct({
    version: Schema.Literal(1),
    state: State,
    durationMs: Schema.optional(Duration),
    todoID: Schema.optional(Schema.String),
    elapsedMs: Count,
    startedAt: Schema.optional(Time),
    runStartedAt: Schema.optional(Time),
    updatedAt: Time,
    completedAt: Schema.optional(Time),
    revision: Revision,
  })
  type Stored = typeof Stored.Type

  export const Info = Schema.Struct({
    ...Stored.fields,
    remainingMs: Count,
    todoExists: Schema.optional(Schema.Boolean),
  })
  export type Info = typeof Info.Type

  export type Operation = "start" | "pause" | "resume" | "reset"

  export class InputError extends Schema.TaggedErrorClass<InputError>()("FocusTimerInputError", {
    field: Schema.Literals(["durationMs", "todoID", "revision", "time", "state"]),
    message: Schema.String,
  }) {}

  export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()(
    "FocusTimerStaleRevisionError",
    {
      operation: Schema.Literals(["start", "pause", "resume", "reset"]),
      expected: Revision,
      actual: Revision,
      message: Schema.String,
    },
  ) {}

  export class TodoNotFoundError extends Schema.TaggedErrorClass<TodoNotFoundError>()("FocusTimerTodoNotFoundError", {
    todoID: Schema.String,
    message: Schema.String,
  }) {}

  type Store = Pick<Storage.Interface, "create" | "read" | "update">
  type Todos = Pick<ReturnType<typeof PersonalTodo.make>, "get">
  type Deps = { storage: Store; todos: Todos; now?: () => number }
  const key = ["raya", "focus-timer", "v1", "state"]
  const decode = Schema.decodeUnknownEffect(Stored)

  export function make(deps: Deps) {
    const clock = () => {
      const at = deps.now?.() ?? Date.now()
      return Number.isFinite(at) && Math.abs(at) <= 8.64e15
        ? Effect.succeed(at)
        : Effect.fail(new InputError({ field: "time", message: "The focus timer clock returned an invalid time." }))
    }
    const revision = (value: number) =>
      Number.isSafeInteger(value) && value >= 1
        ? Effect.succeed(value)
        : Effect.fail(new InputError({ field: "revision", message: "Use a valid focus timer revision." }))
    const duration = (value: number) =>
      Number.isSafeInteger(value) && value >= MIN_DURATION_MS && value <= MAX_DURATION_MS
        ? Effect.succeed(value)
        : Effect.fail(
            new InputError({
              field: "durationMs",
              message: `Use a duration from ${MIN_DURATION_MS} to ${MAX_DURATION_MS} milliseconds.`,
            }),
          )
    const initial = (at: number): Stored => ({
      version: 1,
      state: "idle",
      elapsedMs: 0,
      updatedAt: at,
      revision: 1,
    })
    const read = (at: number) =>
      deps.storage.read<unknown>(key).pipe(
        Effect.flatMap(decode),
        Effect.catchIf(
          (err) => Storage.NotFoundError.isInstance(err),
          () =>
            deps.storage
              .create(key, initial(at))
              .pipe(
                Effect.flatMap((created) =>
                  created ? Effect.succeed(initial(at)) : deps.storage.read<unknown>(key).pipe(Effect.flatMap(decode)),
                ),
              ),
        ),
        Effect.orDie,
      )
    const elapsed = (timer: Stored, at: number) => {
      if (timer.state !== "running" || timer.runStartedAt === undefined) return timer.elapsedMs
      return Math.min(timer.durationMs ?? 0, timer.elapsedMs + Math.max(0, at - timer.runStartedAt))
    }
    const view = Effect.fn("FocusTimer.view")(function* (timer: Stored, at: number) {
      const spent = elapsed(timer, at)
      const done = timer.durationMs !== undefined && spent >= timer.durationMs
      const completedAt =
        done && timer.completedAt === undefined && timer.runStartedAt !== undefined
          ? Math.max(timer.updatedAt, timer.runStartedAt + Math.max(0, timer.durationMs - timer.elapsedMs))
          : timer.completedAt
      const exists = timer.todoID
        ? Boolean(yield* deps.todos.get(timer.todoID).pipe(Effect.catch(() => Effect.succeed(undefined))))
        : undefined
      return {
        ...timer,
        state: done ? ("completed" as const) : timer.state,
        elapsedMs: spent,
        remainingMs: Math.max(0, (timer.durationMs ?? 0) - spent),
        completedAt,
        todoExists: exists,
      }
    })
    const refresh = (at: number) =>
      deps.storage
        .update<Record<string, unknown>>(key, (draft) => {
          const prior = Schema.decodeUnknownSync(Stored)(draft)
          if (prior.state !== "running" || prior.durationMs === undefined) return
          const spent = elapsed(prior, at)
          if (spent >= prior.durationMs) {
            if (prior.revision === Number.MAX_SAFE_INTEGER) return
            const completedAt = Math.max(
              prior.updatedAt,
              (prior.runStartedAt ?? at) + Math.max(0, prior.durationMs - prior.elapsedMs),
            )
            Object.assign(draft, {
              ...prior,
              state: "completed",
              elapsedMs: prior.durationMs,
              runStartedAt: undefined,
              updatedAt: completedAt,
              completedAt,
              revision: prior.revision + 1,
            } satisfies Stored)
            return
          }
          Object.assign(draft, {
            ...prior,
            elapsedMs: spent,
            runStartedAt: Math.max(at, prior.runStartedAt ?? at),
            updatedAt: Math.max(at, prior.updatedAt),
          } satisfies Stored)
        })
        .pipe(Effect.flatMap(decode), Effect.orDie)

    const get = Effect.fn("FocusTimer.get")(function* () {
      const at = yield* clock()
      const saved = yield* read(at)
      const timer = saved.state === "running" ? yield* refresh(at) : saved
      return yield* view(timer, at)
    })

    const mutate = Effect.fn("FocusTimer.mutate")(function* (
      operation: Operation,
      expected: number,
      change: (prior: Stored, at: number) => Stored | InputError,
    ) {
      yield* revision(expected)
      const at = yield* clock()
      yield* read(at)
      const state: { actual?: number; input?: InputError } = {}
      const raw = yield* deps.storage
        .update<Record<string, unknown>>(key, (draft) => {
          const prior = Schema.decodeUnknownSync(Stored)(draft)
          if (prior.revision !== expected || prior.revision === Number.MAX_SAFE_INTEGER) {
            state.actual = prior.revision
            return
          }
          const next = change(prior, at)
          if (next instanceof InputError) {
            state.input = next
            return
          }
          for (const field of Object.keys(draft)) delete draft[field]
          Object.assign(draft, next)
        })
        .pipe(Effect.flatMap(decode), Effect.orDie)
      if (state.actual !== undefined)
        return yield* new StaleRevisionError({
          operation,
          expected,
          actual: state.actual,
          message: "The focus timer changed before this action.",
        })
      if (state.input) return yield* state.input
      return yield* view(raw, at)
    })

    const start = Effect.fn("FocusTimer.start")(function* (input: {
      revision: number
      durationMs: number
      todoID?: string
    }) {
      const length = yield* duration(input.durationMs)
      const todo = input.todoID
        ? yield* deps.todos
            .get(input.todoID)
            .pipe(
              Effect.mapError(
                () => new InputError({ field: "todoID", message: "Use an exact personal todo ID for this timer." }),
              ),
            )
        : undefined
      if (input.todoID && !todo)
        return yield* new TodoNotFoundError({
          todoID: input.todoID,
          message: "The linked personal todo was not found.",
        })
      return yield* mutate("start", input.revision, (prior, at) => ({
        version: 1,
        state: "running",
        durationMs: length,
        todoID: input.todoID,
        elapsedMs: 0,
        startedAt: at,
        runStartedAt: at,
        updatedAt: Math.max(at, prior.updatedAt),
        revision: prior.revision + 1,
      }))
    })
    const pause = (expected: number) =>
      mutate("pause", expected, (prior, at) => {
        if (prior.state !== "running" || prior.durationMs === undefined)
          return new InputError({ field: "state", message: "Only a running focus timer can be paused." })
        const spent = elapsed(prior, at)
        if (spent >= prior.durationMs)
          return {
            ...prior,
            state: "completed",
            elapsedMs: prior.durationMs,
            runStartedAt: undefined,
            updatedAt: Math.max(at, prior.updatedAt),
            completedAt: Math.max(at, prior.updatedAt),
            revision: prior.revision + 1,
          }
        return {
          ...prior,
          state: "paused",
          elapsedMs: spent,
          runStartedAt: undefined,
          updatedAt: Math.max(at, prior.updatedAt),
          revision: prior.revision + 1,
        }
      })
    const resume = (expected: number) =>
      mutate("resume", expected, (prior, at) =>
        prior.state === "paused" && prior.durationMs !== undefined
          ? {
              ...prior,
              state: "running",
              runStartedAt: Math.max(at, prior.updatedAt),
              updatedAt: Math.max(at, prior.updatedAt),
              revision: prior.revision + 1,
            }
          : new InputError({ field: "state", message: "Only a paused focus timer can be resumed." }),
      )
    const reset = (expected: number) =>
      mutate("reset", expected, (prior, at) => ({
        version: 1,
        state: "idle",
        durationMs: prior.durationMs,
        todoID: prior.todoID,
        elapsedMs: 0,
        updatedAt: Math.max(at, prior.updatedAt),
        revision: prior.revision + 1,
      }))

    return { get, start, pause, resume, reset }
  }
}
