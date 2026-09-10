// raya_change - Realtime voice session and media-event API contracts.
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { Envelope, Start, State, VoiceSessionID } from "@/kilocode/voice/protocol"
import {
  OpenAIBinding,
  OpenAICall,
  OpenAICallInput,
  OpenAIGeneration,
  OpenAIImage,
  OpenAIImageInput,
  OpenAIStart,
  VoiceID,
} from "@/kilocode/voice/openai-protocol"

const root = "/kilocode/voice"

export const VoicePaths = {
  start: `${root}/session`,
  state: `${root}/session/:voiceSessionID`,
  event: `${root}/events`,
  openai: `${root}/openai/session`,
  binding: `${root}/openai/session/:id`,
  calls: `${root}/openai/session/:id/calls`,
  images: `${root}/openai/session/:id/images`,
  call: `${root}/openai/session/:id/calls/:callID`,
  cancel: `${root}/openai/session/:id/calls/:callID/cancel`,
} as const

const headers = { "x-raya-voice-key": Schema.optional(Schema.String) }
const errors = [
  HttpApiError.BadRequest,
  HttpApiError.NotFound,
  HttpApiError.Conflict,
  HttpApiError.UnauthorizedNoContent,
] as const
const generation = Schema.Struct({ ...WorkspaceRoutingQueryFields, generation: VoiceID })

export const VoiceApi = HttpApi.make("raya-voice").add(
  HttpApiGroup.make("raya-voice")
    .add(
      HttpApiEndpoint.post("voiceOpenAIStart", VoicePaths.openai, {
        headers,
        query: WorkspaceRoutingQuery,
        payload: OpenAIStart,
        success: OpenAIBinding,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.start",
          summary: "Bind an OpenAI realtime call to an existing Raya session",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceOpenAIImage", VoicePaths.images, {
        headers,
        params: { id: VoiceID },
        query: WorkspaceRoutingQuery,
        payload: OpenAIImageInput,
        success: OpenAIImage,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.image",
          summary: "Stage one immutable image for a bound voice call without starting work",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceOpenAICall", VoicePaths.calls, {
        headers,
        params: { id: VoiceID },
        query: WorkspaceRoutingQuery,
        payload: OpenAICallInput,
        success: OpenAICall,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.call",
          summary: "Admit one deduplicated voice work call",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("voiceOpenAIResult", VoicePaths.call, {
        headers,
        params: { id: VoiceID, callID: VoiceID },
        query: generation,
        success: OpenAICall,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.result",
          summary: "Inspect a retained voice work receipt",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceOpenAICancel", VoicePaths.cancel, {
        headers,
        params: { id: VoiceID, callID: VoiceID },
        query: WorkspaceRoutingQuery,
        payload: OpenAIGeneration,
        success: OpenAICall,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.cancel",
          summary: "Cancel the exact Raya message owned by a voice call",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("voiceOpenAIClose", VoicePaths.binding, {
        headers,
        params: { id: VoiceID },
        query: generation,
        success: OpenAIBinding,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.close",
          summary: "Close voice admission while preserving already-admitted Raya work",
        }),
      ),
    )
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
