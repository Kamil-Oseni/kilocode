import { Schema } from "effect"

const Count = Schema.Number.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const UploadFile = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  selectedName: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
  bytes: Count,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
}).annotate({ identifier: "BrowserUploadFile" })
export const UploadChunk = Schema.Struct({ data: Schema.String, offset: Count, next: Count }).annotate({
  identifier: "BrowserUploadChunk",
})
export const UploadInfo = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  tabID: Schema.String,
  frameID: Schema.optional(Schema.String),
  sessionID: Schema.String,
  directory: Schema.String,
  requestID: Schema.String,
  destination: Schema.String,
  files: Schema.Array(UploadFile),
  status: Schema.Literals(["staging", "selecting", "selected", "failed", "cancelled", "unknown"]),
  createdAt: Count,
  updatedAt: Count,
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "BrowserUploadInfo" })
