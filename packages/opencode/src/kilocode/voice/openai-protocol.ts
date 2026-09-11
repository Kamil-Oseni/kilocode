import { Schema } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"

export const VoiceID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/))
export const VoiceKey = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const OpenAIStart = Schema.Struct({
  parentSessionID: SessionID,
  providerCallID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^\S+$/)),
  requestID: VoiceID,
  model: Schema.optional(Schema.Literals(["gpt-realtime-2.1", "gpt-live-1"])),
}).annotate({ identifier: "OpenAIVoiceStart" })
export const OpenAIBinding = Schema.Struct({
  id: VoiceID,
  generation: VoiceID,
  parentSessionID: SessionID,
  directory: Schema.String,
  providerCallID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^\S+$/)),
  model: Schema.Literals(["gpt-realtime-2.1", "gpt-live-1"]),
  status: Schema.Literals(["active", "closing", "closed"]),
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
}).annotate({ identifier: "OpenAIVoiceBinding" })
export const OpenAIImage = Schema.Struct({
  id: VoiceID,
  mime: Schema.Literals(["image/jpeg", "image/png", "image/webp"]),
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(262144)),
  sha256: VoiceKey,
}).annotate({ identifier: "OpenAIVoiceImage" })
export const OpenAIImageInput = Schema.Struct({
  generation: VoiceID,
  id: VoiceID,
  mime: OpenAIImage.fields.mime,
  data: Schema.String.check(Schema.isMaxLength(349528)),
}).annotate({ identifier: "OpenAIVoiceImageInput" })
export const OpenAICallInput = Schema.Struct({
  generation: VoiceID,
  callID: VoiceID,
  function: Schema.Literal("raya_work"),
  arguments: Schema.Struct({
    request: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(8000)),
    images: Schema.optional(Schema.Array(VoiceID).check(Schema.isMaxLength(4))),
  }),
  responseID: Schema.optional(VoiceID),
  itemID: Schema.optional(VoiceID),
}).annotate({ identifier: "OpenAIVoiceCallInput" })
export const OpenAICall = Schema.Struct({
  id: VoiceID,
  callID: VoiceID,
  messageID: MessageID,
  parentSessionID: SessionID,
  status: Schema.Literals(["accepted", "running", "completed", "failed", "cancelled", "unknown"]),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  images: Schema.optional(Schema.Array(OpenAIImage).check(Schema.isMaxLength(4))),
  result: Schema.optional(
    Schema.Struct({
      text: Schema.String.check(Schema.isMaxLength(12000)),
      assistantMessageID: MessageID,
      evidence: Schema.Array(
        Schema.Struct({
          messageID: MessageID,
          partID: PartID,
          tool: Schema.String.check(Schema.isMaxLength(128)),
          status: Schema.Literals(["pending", "running", "completed", "error"]),
        }),
      ).check(Schema.isMaxLength(64)),
    }),
  ),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.String.check(Schema.isMaxLength(64)),
      message: Schema.String.check(Schema.isMaxLength(500)),
    }),
  ),
}).annotate({ identifier: "OpenAIVoiceCall" })
export const OpenAIGeneration = Schema.Struct({ generation: VoiceID })
