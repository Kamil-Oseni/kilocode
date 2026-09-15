import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { FocusTimer } from "@/kilocode/focus-timer"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { Storage } from "@/storage/storage"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { InvalidRequestError, notFound } from "@/server/routes/instance/httpapi/errors"
import { FocusTimerStaleRevisionError } from "../groups/focus-timer"

function api<A, R>(
  self: Effect.Effect<A, FocusTimer.InputError | FocusTimer.StaleRevisionError | FocusTimer.TodoNotFoundError, R>,
) {
  return self.pipe(
    Effect.catchTag("FocusTimerInputError", (err) =>
      Effect.fail(new InvalidRequestError({ message: err.message, kind: "focus-timer", field: err.field })),
    ),
    Effect.catchTag("FocusTimerTodoNotFoundError", (err) =>
      Effect.fail(notFound(`Personal todo ${err.todoID} not found.`)),
    ),
    Effect.catchTag("FocusTimerStaleRevisionError", (err) =>
      Effect.fail(
        new FocusTimerStaleRevisionError({
          name: "FocusTimerStaleRevisionError",
          data: {
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

export const focusTimerHandlers = HttpApiBuilder.group(InstanceHttpApi, "raya-focus-timer", (handlers) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const todos = PersonalTodo.make({ storage })
    const timer = FocusTimer.make({ storage, todos })

    return handlers
      .handle("focusTimerGet", () => api(timer.get()))
      .handle("focusTimerStart", (ctx) => api(timer.start(ctx.payload)))
      .handle("focusTimerPause", (ctx) => api(timer.pause(ctx.payload.revision)))
      .handle("focusTimerResume", (ctx) => api(timer.resume(ctx.payload.revision)))
      .handle("focusTimerReset", (ctx) => api(timer.reset(ctx.payload.revision)))
  }),
)
