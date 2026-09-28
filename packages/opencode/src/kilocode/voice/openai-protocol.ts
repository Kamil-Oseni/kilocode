import { Schema } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"

export const VoiceID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/))
export const VoiceKey = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Revision = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const Relation = {
  version: Schema.Literal(1),
  requestID: VoiceID,
  sourceID: VoiceID,
  sourceGeneration: VoiceID,
  candidateID: VoiceID,
  candidateGeneration: VoiceID,
}
const Checkpoint = { sourceRevision: Revision, sourceHash: VoiceKey, readyID: VoiceID }
export const OpenAIHandoffReceipt = Schema.Struct({
  ...Relation,
  ...Checkpoint,
  activatedAt: Schema.Finite,
})
export const OpenAIHandoff = Schema.Struct({
  ...Relation,
  phase: Schema.Literals(["candidate", "ready", "active", "retiring"]),
  sourceRevision: Schema.optional(Revision),
  sourceHash: Schema.optional(VoiceKey),
  readyID: Schema.optional(VoiceID),
  deadline: Schema.optional(Schema.Finite),
  receipt: Schema.optional(OpenAIHandoffReceipt),
}).check(
  Schema.makeFilter((value) => {
    const checkpoint =
      value.sourceRevision !== undefined && value.sourceHash !== undefined && value.readyID !== undefined
    if (value.sourceID === value.candidateID || value.sourceGeneration === value.candidateGeneration)
      return "Handoff identities must be distinct"
    if (value.phase === "ready" && (!checkpoint || value.deadline === undefined || value.receipt !== undefined))
      return "Ready handoff requires an uncommitted checkpoint"
    if (value.phase === "candidate" && (checkpoint || value.deadline !== undefined || value.receipt !== undefined))
      return "Candidate handoff cannot have a ready checkpoint"
    if (value.phase === "retiring" && !value.receipt) return "Retiring handoff requires an activation receipt"
    if (value.phase === "active" && !value.receipt && (checkpoint || value.deadline !== undefined))
      return "Preparing source authority cannot contain a ready checkpoint"
    if (
      Object.values(value).some((field) => typeof field === "string" && field.trim() !== field) ||
      (value.receipt &&
        Object.values(value.receipt).some((field) => typeof field === "string" && field.trim() !== field))
    )
      return "Handoff identifiers cannot contain trailing whitespace"
    if (
      value.receipt &&
      ((value.phase !== "active" && value.phase !== "retiring") ||
        Object.keys(Relation).some(
          (key) => value[key as keyof typeof Relation] !== value.receipt![key as keyof typeof Relation],
        ) ||
        Object.keys(Checkpoint).some(
          (key) => value[key as keyof typeof Checkpoint] !== value.receipt![key as keyof typeof Checkpoint],
        ))
    )
      return "Handoff receipt must match its relation and checkpoint"
    if (
      !checkpoint &&
      (value.sourceRevision !== undefined || value.sourceHash !== undefined || value.readyID !== undefined)
    )
      return "Handoff checkpoint cannot be partial"
    return undefined
  }),
)
export const OpenAIHandoffCandidate = Schema.Struct({
  version: Schema.Literal(1),
  generation: VoiceID,
  requestID: VoiceID,
  providerCallID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^\S+$/)),
  reservationID: VoiceID,
  transcriptionRequestID: Schema.optional(VoiceID),
})
export const OpenAIHandoffReady = Schema.Struct({ version: Schema.Literal(1), generation: VoiceID, ...Checkpoint })
export const OpenAIHandoffRearm = Schema.Struct({
  ...OpenAIHandoffReady.fields,
  priorReadyID: VoiceID,
})
export const OpenAIHandoffRearmReceipt = Schema.Struct({
  ...Relation,
  ...Checkpoint,
  priorReadyID: VoiceID,
  deadline: Schema.Finite,
  rearmedAt: Schema.Finite,
}).check(
  Schema.makeFilter((value) =>
    value.priorReadyID === value.readyID ||
    value.sourceID === value.candidateID ||
    value.sourceGeneration === value.candidateGeneration ||
    Object.values(value).some((field) => typeof field === "string" && field.trim() !== field)
      ? "Rearm identities must be strict and distinct"
      : undefined,
  ),
)
export const OpenAIHandoffActivate = Schema.Struct({
  version: Schema.Literal(1),
  generation: VoiceID,
  requestID: VoiceID,
  candidateID: VoiceID,
  candidateGeneration: VoiceID,
  ...Checkpoint,
})
export const OpenAIHandoffContext = Schema.Struct({
  version: Schema.Literal(1),
  sourceID: VoiceID,
  sourceGeneration: VoiceID,
  sourceRevision: Revision,
  sourceHash: VoiceKey,
  items: Schema.Array(
    Schema.Struct({ itemID: VoiceID, role: Schema.Literals(["user", "assistant"]), text: Schema.String }),
  ).check(Schema.isMaxLength(128)),
  incomplete: Schema.Boolean,
})
/** HTTP decoders may strip unknown properties; validate the original privileged body too. */
export function handoff(input: unknown, kind: "candidate" | "ready" | "activate" | "rearm") {
  const valid =
    kind === "candidate"
      ? Schema.is(OpenAIHandoffCandidate)(input)
      : kind === "ready"
        ? Schema.is(OpenAIHandoffReady)(input)
        : kind === "rearm"
          ? Schema.is(OpenAIHandoffRearm)(input)
          : Schema.is(OpenAIHandoffActivate)(input)
  if (!valid || typeof input !== "object" || input === null) return false
  const fields =
    kind === "candidate"
      ? OpenAIHandoffCandidate.fields
      : kind === "ready"
        ? OpenAIHandoffReady.fields
        : kind === "rearm"
          ? OpenAIHandoffRearm.fields
          : OpenAIHandoffActivate.fields
  return (
    Object.keys(input).every((key) => Object.keys(fields).includes(key)) &&
    Object.values(input).every((value) => typeof value !== "string" || value.trim() === value)
  )
}
export const OpenAIReserve = Schema.Struct({
  parentSessionID: SessionID,
  requestID: VoiceID,
  model: Schema.Literals(["gpt-realtime-2.1", "gpt-live-1", "gpt-live-transcribe"]),
}).annotate({ identifier: "OpenAIVoiceReserve" })
export const OpenAIReservation = Schema.Struct({
  requestID: VoiceID,
  model: OpenAIReserve.fields.model,
  status: Schema.Literals(["reserved", "released"]),
  amount: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000))),
  currency: Schema.optional(Schema.Literal("USD")),
  maximumSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(86_400)),
  ),
}).annotate({ identifier: "OpenAIVoiceReservation" })
export const OpenAIStart = Schema.Struct({
  parentSessionID: SessionID,
  providerCallID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^\S+$/)),
  requestID: VoiceID,
  transcriptionRequestID: Schema.optional(VoiceID),
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
  handoff: Schema.optional(OpenAIHandoff),
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
