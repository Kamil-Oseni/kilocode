import { Schema } from "effect"

const file = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096), Schema.isPattern(/^[^\0\r\n]+$/))
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

/** Read-only selection metadata. This grants neither capture nor complete backup authority. */
export const SourceSelection = Schema.Struct({
  format: Schema.Literal("raya.source-export-selection"),
  version: Schema.Literal(1),
  source: Schema.Struct({
    pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    birth: Schema.String.check(Schema.isPattern(/^\d{1,20}$/)),
    executable: file,
    digest,
  }),
  profile: Schema.Struct({ database: file, storage: file, data: file, exports: Schema.optional(file) }),
  fingerprint: digest,
  preferences: Schema.Literal("authenticated-capture-only"),
  completeProfileCoverage: Schema.Literal(false),
  portableCaptureAuthorized: Schema.Literal(false),
  restartRequired: Schema.Literal(true),
})
