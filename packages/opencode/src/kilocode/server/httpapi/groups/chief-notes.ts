import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { ApiNotFoundError } from "@/server/routes/instance/httpapi/errors"

export const ChiefNotesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  goalCreatedAt: Schema.NumberFromString,
  requestID: Schema.String,
  revision: Schema.String,
})

const Note = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  branchID: Schema.String,
  branchName: Schema.String,
  childSessionID: SessionID,
  text: Schema.String,
  at: Schema.Number,
  state: Schema.Literal("delivered"),
})

export const ChiefNotesResponse = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: SessionID,
  goalCreatedAt: Schema.Number,
  requestID: Schema.String,
  revision: Schema.String,
  notes: Schema.Array(Note),
})

export const ChiefNotesApi = HttpApi.make("chief-notes")
  .add(
    HttpApiGroup.make("chief-notes")
      .add(
        HttpApiEndpoint.get("list", "/session/:sessionID/chief/notes", {
          params: { sessionID: SessionID },
          query: ChiefNotesQuery,
          success: described(ChiefNotesResponse, "Notes from the exact active Chief plan"),
          error: [ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.session.chiefNotes",
            summary: "Read Chief branch notes",
            description: "Read bounded, durable notes for an exact active Chief request and revision.",
          }),
        ),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(OpenApi.annotations({ title: "Raya API", version: "0.0.1" }))
