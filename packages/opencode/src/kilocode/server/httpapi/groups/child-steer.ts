import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { MessageID, SessionID } from "@/session/schema"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { ApiNotFoundError } from "@/server/routes/instance/httpapi/errors"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

export const ChildSteerPayload = Schema.Struct({
  messageID: MessageID,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000), Schema.isPattern(/\S/)),
})

export const ChildSteerReceipt = Schema.Struct({
  parentSessionID: SessionID,
  childSessionID: SessionID,
  messageID: MessageID,
  replayed: Schema.Boolean,
})

export class ChildSteerConflictError extends Schema.ErrorClass<ChildSteerConflictError>("ChildSteerConflictError")(
  {
    code: Schema.Literals(["inactive", "stale-run", "changed-replay", "admission-failed"]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export const ChildSteerPath = "/session/:parentSessionID/child/:childSessionID/steer"

export const ChildSteerApi = HttpApi.make("child-steer")
  .add(
    HttpApiGroup.make("child-steer")
      .add(
        HttpApiEndpoint.post("steer", ChildSteerPath, {
          params: { parentSessionID: SessionID, childSessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ChildSteerPayload,
          success: described(ChildSteerReceipt, "Child steering admission receipt"),
          error: [ApiNotFoundError, ChildSteerConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.session.childSteer",
            summary: "Steer a running child session",
            description:
              "Admit a correlated instruction only when the target is the named parent's direct, currently running child.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({ title: "child-steer", description: "Kilo direct child-session steering routes." }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "kilo HttpApi",
      version: "0.0.1",
      description: "Kilo HttpApi surface.",
    }),
  )
