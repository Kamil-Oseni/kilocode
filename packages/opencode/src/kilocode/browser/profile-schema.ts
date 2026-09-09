import { Schema } from "effect"

const Count = Schema.Number.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const ProfileID = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const CaptureID = Schema.String.check(Schema.isUUID())
export const AuthSource = Schema.Struct({
  source: Schema.Literals(["live", "capture"]),
  profileID: Schema.String,
  captureID: Schema.optional(CaptureID),
  captureName: Schema.optional(Schema.String),
  capturedAt: Schema.optional(Count),
  expiresAt: Schema.optional(Count),
  login: Schema.Literal("unverified"),
}).annotate({ identifier: "BrowserAuthSource" })
export const ProfileInfo = Schema.Struct({
  profileID: Schema.String,
  directory: Schema.String,
  status: Schema.Literals(["ready", "closed", "unavailable", "locked", "error", "auth_expired"]),
  message: Schema.optional(Schema.String),
  authentication: AuthSource,
}).annotate({ identifier: "BrowserProfileInfo" })
export const CaptureInfo = Schema.Struct({
  id: CaptureID,
  profileID: Schema.String,
  directory: Schema.String,
  name: Schema.String,
  createdAt: Count,
  expiresAt: Count,
  origins: Schema.Array(Schema.String),
  domains: Schema.Array(Schema.String),
  cookies: Count,
  bytes: Count,
  sha256: Schema.String,
  status: Schema.Literals(["available", "expired", "missing", "invalid"]),
}).annotate({ identifier: "BrowserCaptureInfo" })
