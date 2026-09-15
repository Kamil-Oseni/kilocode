import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { FocusTimer } from "@/kilocode/focus-timer"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { InvalidRequestError, ApiNotFoundError } from "@/server/routes/instance/httpapi/errors"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"

const root = "/raya/focus-timer"

export const FocusTimerPaths = {
  get: root,
  start: `${root}/start`,
  pause: `${root}/pause`,
  resume: `${root}/resume`,
  reset: `${root}/reset`,
} as const

export const FocusTimerStartPayload = Schema.Struct({
  revision: Schema.Number,
  durationMs: Schema.Number,
  todoID: Schema.optional(Schema.String),
})

export const FocusTimerMutationPayload = Schema.Struct({ revision: Schema.Number })

export class FocusTimerStaleRevisionError extends Schema.ErrorClass<FocusTimerStaleRevisionError>(
  "FocusTimerStaleRevisionError",
)(
  {
    name: Schema.Literal("FocusTimerStaleRevisionError"),
    data: Schema.Struct({
      operation: Schema.Literals(["start", "pause", "resume", "reset"]),
      expected: Schema.Number,
      actual: Schema.Number,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 409 },
) {}

const errors = [InvalidRequestError, ApiNotFoundError, FocusTimerStaleRevisionError] as const

export const FocusTimerApi = HttpApi.make("raya-focus-timer").add(
  HttpApiGroup.make("raya-focus-timer")
    .add(
      HttpApiEndpoint.get("focusTimerGet", FocusTimerPaths.get, {
        query: WorkspaceRoutingQuery,
        success: described(FocusTimer.Info, "Focus timer"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.focusTimer.get",
          summary: "Get the focus timer",
          description: "Read restart-safe focus progress derived from persisted wall-clock timestamps.",
        }),
      ),
      HttpApiEndpoint.post("focusTimerStart", FocusTimerPaths.start, {
        query: WorkspaceRoutingQuery,
        payload: FocusTimerStartPayload,
        success: described(FocusTimer.Info, "Started focus timer"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.focusTimer.start",
          summary: "Start the focus timer",
          description: "Start a revision-fenced focus timer, optionally linked to an exact personal todo.",
        }),
      ),
      HttpApiEndpoint.post("focusTimerPause", FocusTimerPaths.pause, {
        query: WorkspaceRoutingQuery,
        payload: FocusTimerMutationPayload,
        success: described(FocusTimer.Info, "Paused focus timer"),
        error: errors,
      }).annotateMerge(OpenApi.annotations({ identifier: "raya.focusTimer.pause", summary: "Pause the focus timer" })),
      HttpApiEndpoint.post("focusTimerResume", FocusTimerPaths.resume, {
        query: WorkspaceRoutingQuery,
        payload: FocusTimerMutationPayload,
        success: described(FocusTimer.Info, "Resumed focus timer"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "raya.focusTimer.resume", summary: "Resume the focus timer" }),
      ),
      HttpApiEndpoint.post("focusTimerReset", FocusTimerPaths.reset, {
        query: WorkspaceRoutingQuery,
        payload: FocusTimerMutationPayload,
        success: described(FocusTimer.Info, "Reset focus timer"),
        error: errors,
      }).annotateMerge(OpenApi.annotations({ identifier: "raya.focusTimer.reset", summary: "Reset the focus timer" })),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
