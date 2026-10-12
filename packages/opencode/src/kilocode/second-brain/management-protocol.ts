import { Schema } from "effect"

const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const id = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const text = (limit: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(limit), Schema.isPattern(/\S/))
const integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(16000))

/** Internal backend provenance, never supplied by model-facing tool arguments. */
export const ManageSource = Schema.Struct({
  sessionID: text(256),
  messageID: text(256),
  created_utc: text(32),
  text: text(16000),
  source_sha256: hash,
}).annotate({ identifier: "SecondBrainManageSource" })
export type ManageSource = typeof ManageSource.Type

export const Manage = Schema.Struct({
  action: Schema.Literal("manage"),
  stage: Schema.Literal("inspect"),
  mode: Schema.Literals(["remember", "correct", "forget"]),
  operation: id,
  source: ManageSource,
  fact: Schema.optional(Schema.Struct({ start: integer, end: integer })),
  query: Schema.optional(text(2000)),
}).annotate({ identifier: "SecondBrainManage" })
export type Manage = typeof Manage.Type

export const ManageResult = Schema.Struct({
  action: Schema.Literal("manage"),
  project: text(4096),
  operation: id,
  sessionID: text(256),
  messageID: text(256),
  source_sha256: hash,
  mode: Manage.fields.mode,
  disposition: Schema.Literals(["pending", "cancelled", "published", "indexed", "no_match", "unconfirmed"]),
  publication_confirmed: Schema.Boolean,
  index_confirmed: Schema.Boolean,
  changes: Schema.Array(
    Schema.Struct({
      relative: text(512),
      note_sha256: Schema.NullOr(hash),
    }),
  ).check(Schema.isMaxLength(16)),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
}).annotate({ identifier: "SecondBrainManageResult" })
export type ManageResult = typeof ManageResult.Type
