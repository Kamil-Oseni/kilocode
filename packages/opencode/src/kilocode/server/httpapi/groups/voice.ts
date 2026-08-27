// raya_change - Realtime voice session and media-event API contracts.
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { Envelope, Start, State, VoiceSessionID } from "@/kilocode/voice/protocol"

const root = "/kilocode/voice"

export const VoicePaths = {
  start: `${root}/session`,
  state: `${root}/session/:voiceSessionID`,
  event: `${root}/events`,
} as const

export const VoiceApi = HttpApi.make("raya-voice").add(
  HttpApiGroup.make("raya-voice")
    .add(
      HttpApiEndpoint.post("voiceStart", VoicePaths.start, {
        query: WorkspaceRoutingQuery,
        payload: Start,
        success: described(State.fields.info, "Realtime voice session connection"),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.start",
          summary: "Start a realtime voice session",
          description: "Mint thin-client and media-frontend room credentials without exposing provider secrets.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("voiceState", VoicePaths.state, {
        params: { voiceSessionID: VoiceSessionID },
        query: WorkspaceRoutingQuery,
        success: described(State, "Authoritative realtime voice state"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.state",
          summary: "Get reconstructed voice state",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceEvent", VoicePaths.event, {
        query: WorkspaceRoutingQuery,
        payload: Envelope,
        success: described(Schema.Boolean, "Media event accepted"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.event",
          summary: "Ingest one ordered media-plane event",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("voiceClose", VoicePaths.state, {
        params: { voiceSessionID: VoiceSessionID },
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Voice session closed"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.close",
          summary: "Close a realtime voice session",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
