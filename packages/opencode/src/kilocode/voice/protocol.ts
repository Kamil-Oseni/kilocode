// raya_change - Two-plane realtime voice contracts shared by the Kilo async plane.
import { Schema } from "effect"
import { SessionID } from "@/session/schema"

export const VoiceSessionID = Schema.String.pipe(Schema.brand("RayaVoiceSessionID"))
export type VoiceSessionID = typeof VoiceSessionID.Type

export const Start = Schema.Struct({
  parentSessionID: SessionID,
  mediaURL: Schema.String,
  room: Schema.optional(Schema.String),
})

export const Info = Schema.Struct({
  id: VoiceSessionID,
  parentSessionID: SessionID,
  room: Schema.String,
  livekitURL: Schema.String,
  clientToken: Schema.String,
  mediaToken: Schema.String,
  mediaURL: Schema.String,
  engine: Schema.Literal("qwen-realtime"),
  acceptsTruncation: Schema.Boolean,
  status: Schema.Literals(["starting", "active", "closed", "failed"]),
  createdAt: Schema.Number,
})

export const MediaEvent = Schema.Struct({
  seq: Schema.Number,
  type: Schema.String,
  session: Schema.optional(Schema.String),
  turn: Schema.optional(Schema.String),
  item: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  stable: Schema.optional(Schema.Boolean),
  truncated: Schema.optional(Schema.Boolean),
  heardMs: Schema.optional(Schema.Number),
  at: Schema.String,
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const Envelope = Schema.Struct({
  session: VoiceSessionID,
  seq: Schema.Number,
  event: MediaEvent,
})

export const ContextItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  call: Schema.optional(Schema.String),
  ttl: Schema.optional(Schema.Number),
  created: Schema.String,
  supersedes: Schema.optional(Schema.String),
})

export const Turn = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  speculative: Schema.String,
  authoritative: Schema.optional(Schema.String),
  stable: Schema.Boolean,
  truncated: Schema.Boolean,
  heardMs: Schema.optional(Schema.Number),
  overlap: Schema.Boolean,
})

export const Failure = Schema.Struct({
  code: Schema.Literals([
    "room_data_closed",
    "room_input_closed",
    "engine_audio_closed",
    "engine_events_closed",
    "audio_input",
    "audio_publish",
    "playout_metadata",
    "transcript_send",
    "playout_flush",
    "engine_interrupt",
    "interruption_send",
    "backend_delivery",
    "event_queue_overflow",
    "engine_failure",
    "engine_inject",
  ]),
  message: Schema.String.check(Schema.isMaxLength(500)),
  recovery: Schema.String.check(Schema.isMaxLength(500)),
  at: Schema.String,
})

export const State = Schema.Struct({
  info: Info,
  lastSeq: Schema.Number,
  incomplete: Schema.Boolean,
  failure: Schema.optional(Failure),
  turns: Schema.Array(Turn),
})
