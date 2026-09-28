import { OpenAIUsage, OpenAIUsageInput, OpenAIUsageState } from "@/kilocode/voice/openai-usage"
import { LiveCall, LiveDuration, LiveMeter } from "@/kilocode/voice/live-protocol"
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
import * as Spoken from "@/kilocode/voice/openai-spoken"
import { Envelope, Start, State, VoiceSessionID } from "@/kilocode/voice/protocol"
import {
  OpenAIBinding,
  OpenAICall,
  OpenAICallInput,
  OpenAIGeneration,
  OpenAIImage,
  OpenAIImageInput,
  OpenAIReservation,
  OpenAIReserve,
  OpenAIStart,
  OpenAIHandoffCandidate,
  OpenAIHandoffReady,
  OpenAIHandoffRearm,
  OpenAIHandoffRearmReceipt,
  OpenAIHandoffActivate,
  OpenAIHandoffContext,
  OpenAIHandoffReceipt,
  VoiceID,
} from "@/kilocode/voice/openai-protocol"

const root = "/kilocode/voice"

export const VoicePaths = {
  start: `${root}/session`,
  state: `${root}/session/:voiceSessionID`,
  event: `${root}/events`,
  openai: `${root}/openai/session`,
  reserve: `${root}/openai/reservation`,
  release: `${root}/openai/reservation/release`,
  binding: `${root}/openai/session/:id`,
  calls: `${root}/openai/session/:id/calls`,
  images: `${root}/openai/session/:id/images`,
  usage: `${root}/openai/session/:id/usage`,
  call: `${root}/openai/session/:id/calls/:callID`,
  cancel: `${root}/openai/session/:id/calls/:callID/cancel`,
  live: `${root}/live/session/:id/calls`,
  duration: `${root}/live/session/:id/duration`,
  spoken: `${root}/openai/session/:id/spoken`,
  context: `${root}/openai/session/:id/context`,
  candidate: `${root}/openai/session/:id/handoff/candidate`,
  checkpoint: `${root}/openai/session/:id/handoff/context`,
  ready: `${root}/openai/session/:id/handoff/ready`,
  rearm: `${root}/openai/session/:id/handoff/rearm`,
  activate: `${root}/openai/session/:id/handoff/activate`,
  receipt: `${root}/openai/session/:id/handoff/receipt`,
} as const

const headers = { "x-raya-voice-key": Schema.optional(Schema.String) }
const mediaHeaders = { "x-raya-media-key": Schema.String }
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
      HttpApiEndpoint.post("voiceOpenAIHandoffCandidate", VoicePaths.candidate, {
        headers: { ...headers, "x-raya-voice-target-key": Schema.String },
        params: { id: VoiceID },
        query: WorkspaceRoutingQuery,
        payload: OpenAIHandoffCandidate,
        success: OpenAIBinding,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.handoff.candidate",
          summary: "Prepare a non-admitting replacement under exact source authority",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("voiceOpenAIHandoffContext", VoicePaths.checkpoint, {
        headers,
        params: { id: VoiceID },
        query: generation,
        success: OpenAIHandoffContext,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.handoff.context",
          summary: "Read the exact source speech checkpoint for replacement prefill",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceOpenAIHandoffReady", VoicePaths.ready, {
        headers,
        params: { id: VoiceID },
        query: WorkspaceRoutingQuery,
        payload: OpenAIHandoffReady,
        success: OpenAIBinding,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.handoff.ready",
          summary: "Record bounded trusted broker readiness for an unchanged source checkpoint",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceOpenAIHandoffRearm", VoicePaths.rearm, {
        headers,
        params: { id: VoiceID },
        query: WorkspaceRoutingQuery,
        payload: OpenAIHandoffRearm,
        success: OpenAIHandoffRearmReceipt,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.handoff.rearm",
          summary: "Compare and replace readiness without extending the warming deadline",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceOpenAIHandoffActivate", VoicePaths.activate, {
        headers,
        params: { id: VoiceID },
        query: WorkspaceRoutingQuery,
        payload: OpenAIHandoffActivate,
        success: OpenAIHandoffReceipt,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.handoff.activate",
          summary: "Atomically transfer work authority and retain an exact activation receipt",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("voiceOpenAIHandoffReceipt", VoicePaths.receipt, {
        headers,
        params: { id: VoiceID },
        query: generation,
        success: OpenAIHandoffReceipt,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.handoff.receipt",
          summary: "Resolve an ambiguous activation without replaying work",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceOpenAISpoken", VoicePaths.spoken, {
        headers,
        params: { id: VoiceID },
        query: WorkspaceRoutingQuery,
        payload: Spoken.Input,
        success: Spoken.Receipt,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.spoken",
          summary: "Retain a bounded same-task spoken recovery snapshot",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("voiceOpenAIContext", VoicePaths.context, {
        headers,
        params: { id: VoiceID },
        query: generation,
        success: Spoken.Context,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.context",
          summary: "Recover recent speech for the exact active Raya task without replaying work",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceLiveCall", VoicePaths.live, {
        headers,
        params: { id: VoiceID },
        query: WorkspaceRoutingQuery,
        payload: LiveCall,
        success: OpenAICall,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.live.call",
          summary: "Admit one immutable Live delegation using observed transcript context",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceLiveDuration", VoicePaths.duration, {
        headers,
        params: { id: VoiceID },
        query: WorkspaceRoutingQuery,
        payload: LiveMeter,
        success: LiveDuration,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.live.duration",
          summary: "Retain final provider-reported Live voice duration",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceOpenAIReserve", VoicePaths.reserve, {
        headers,
        query: WorkspaceRoutingQuery,
        payload: OpenAIReserve,
        success: OpenAIReservation,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.reserve",
          summary: "Reserve goal budget before starting a billable OpenAI voice session",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("voiceOpenAIRelease", VoicePaths.release, {
        headers,
        query: WorkspaceRoutingQuery,
        payload: OpenAIReserve,
        success: OpenAIReservation,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.release",
          summary: "Release a voice reservation after a definite provider refusal",
        }),
      ),
    )
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
      HttpApiEndpoint.post("voiceOpenAIMeter", VoicePaths.usage, {
        headers,
        params: { id: VoiceID },
        query: WorkspaceRoutingQuery,
        payload: OpenAIUsageInput,
        success: OpenAIUsage,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.meter",
          summary: "Retain an immutable provider-reported voice usage receipt",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("voiceOpenAIUsage", VoicePaths.usage, {
        headers,
        params: { id: VoiceID },
        query: generation,
        success: OpenAIUsageState,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "kilocode.voice.openai.usage",
          summary: "Inspect retained voice usage receipts without treating missing usage as zero",
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
        headers: mediaHeaders,
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
