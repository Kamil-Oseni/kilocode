import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"

export const RequestID = Schema.String.pipe(Schema.brand("SecondBrainRequestID")).annotate({
  identifier: "SecondBrainRequestID",
})
export type RequestID = typeof RequestID.Type
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const ID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Text = Schema.String.check(Schema.isMaxLength(250000))
const Source = Schema.Struct({
  path: Path,
  sha256: Hash,
  kind: Schema.Literals(["user_statement", "tool_observation", "document", "assistant_interpretation"]),
  event_time: Schema.NullOr(Schema.String.check(Schema.isMaxLength(80))),
})
const Change = Schema.Struct({ path: Path, expected: Schema.NullOr(Hash), content: Schema.NullOr(Text) })
const Draft = Schema.Struct({
  changes: Schema.Array(Change).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  sources: Schema.Array(Source).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
})
export const Command = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literal("read"), id: ID }),
  Schema.Struct({ action: Schema.Literal("propose"), id: ID, request: Draft }),
]).annotate({ identifier: "SecondBrainCommand" })
export type Command = typeof Command.Type
export const Request = Schema.Struct({ id: RequestID, sessionID: SessionID, project: Path, command: Command }).annotate(
  { identifier: "SecondBrainRequest" },
)
export type Request = typeof Request.Type
const Proposal = Schema.Struct({
  format: Schema.Literal("raya.memory.proposal.v1"),
  id: ID,
  project: Path,
  digest: Hash,
  status: Schema.Literals(["pending", "cancelled", "applying", "applied"]),
  capture_enabled: Schema.Literal(false),
  sources: Schema.Array(Source).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  changes: Schema.Array(
    Schema.Struct({ ...Change.fields, before: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256000))) }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  provenance: Schema.String.check(Schema.isMaxLength(4096)),
})
export const Result = Schema.Struct({
  action: Schema.Literals(["list", "read", "propose"]),
  project: Path,
  proposals: Schema.Array(Proposal).check(Schema.isMaxLength(128)),
}).annotate({ identifier: "SecondBrainResult" })
export type Result = typeof Result.Type
export const ErrorCode = Schema.Literals([
  "cancelled",
  "disconnected",
  "invalid_request",
  "not_found",
  "timeout",
  "unsupported",
  "conflict",
])
export const Failure = Schema.Struct({
  code: ErrorCode,
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
}).annotate({ identifier: "SecondBrainFailure" })
export type Failure = typeof Failure.Type
export const Event = {
  Requested: BusEvent.define("kilocode.second_brain.requested", Request),
  Cancelled: BusEvent.define(
    "kilocode.second_brain.cancelled",
    Schema.Struct({
      requestID: RequestID,
      sessionID: SessionID,
      reason: Schema.Literals(["cancelled", "disposed", "timeout"]),
    }),
  ),
}
