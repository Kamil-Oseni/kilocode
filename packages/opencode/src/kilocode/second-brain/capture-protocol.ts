import { Schema } from "effect"

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const uuid = Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/))
const integer = (max: number) => Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(max))
export const CaptureSource = Schema.Struct({
  user: Schema.Struct({ id: text(256), text: text(16000) }),
  assistant: Schema.Struct({ id: text(256), text: text(16000) }),
  tools: Schema.Array(
    Schema.Struct({
      id: text(256),
      name: text(256),
      status: Schema.Literals(["completed", "error"]),
      text: text(4000),
    }),
  ).check(Schema.isMaxLength(16)),
})
export type CaptureSource = typeof CaptureSource.Type
export const CaptureEntry = Schema.Struct({
  category: Schema.Literals(["Daily", "Preferences", "Projects", "Areas", "Commitments", "Decisions"]),
  key: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,79}$/)),
  text: text(4096),
  origin: Schema.Literals(["user_statement", "tool_observation", "assistant_interpretation"]),
  evidence: Schema.Array(Schema.Struct({ id: text(256), start: integer(16000), end: integer(16000) })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4),
  ),
})
export const CaptureEntries = Schema.Array(CaptureEntry).check(Schema.isMaxLength(8))
export type CaptureEntries = typeof CaptureEntries.Type
export const CapturePolicy = Schema.Struct({
  action: Schema.Literal("capturePolicy"),
  messageID: text(256),
  source_sha256: hash,
})
export const Capture = Schema.Struct({
  action: Schema.Literal("capture"),
  id: uuid,
  grant: uuid,
  messageID: text(256),
  observed_utc: text(80),
  source_sha256: hash,
  source: CaptureSource,
  entries: CaptureEntries,
})
export const CapturePolicyResult = Schema.Struct({
  action: Schema.Literal("capturePolicy"),
  project: text(4096),
  sessionID: text(256),
  messageID: text(256),
  source_sha256: hash,
  enabled: Schema.Boolean,
  grant: Schema.optional(
    Schema.Struct({
      id: uuid,
      root: text(4096),
      release: hash,
      zone: text(255),
      model: text(512),
      expires: Schema.Number.check(Schema.isFinite()),
    }),
  ),
})
export const CaptureResult = Schema.Struct({
  action: Schema.Literal("capture"),
  project: text(4096),
  sessionID: text(256),
  messageID: text(256),
  source_sha256: hash,
  status: Schema.Literals(["published", "duplicate", "skipped"]),
  receipt: Schema.optional(hash),
})
