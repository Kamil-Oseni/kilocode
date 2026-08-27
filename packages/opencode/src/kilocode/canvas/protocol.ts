// raya_change - Milestone E typed canvas host protocol
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"

export const RequestID = Schema.String.pipe(Schema.brand("CanvasRequestID")).annotate({
  identifier: "CanvasRequestID",
})
export type RequestID = Schema.Schema.Type<typeof RequestID>

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))
const Source = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000_000))
export const Data = Schema.Record(Schema.String, Schema.Unknown)
export type Data = Schema.Schema.Type<typeof Data>
const Base = { id: RequestID, sessionID: SessionID }

export const CreateRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("create"),
  name: Name,
  source: Source,
  data: Data,
})
export const UpdateRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("update"),
  name: Name,
  source: Schema.optional(Source),
  data: Schema.optional(Data),
})
export const Request = Schema.Union([CreateRequest, UpdateRequest]).annotate({ identifier: "CanvasRequest" })
export type Request = Schema.Schema.Type<typeof Request>

export const Result = Schema.Struct({
  operation: Schema.Literals(["create", "update"]),
  name: Name,
  path: Schema.String,
  status: Schema.Literals(["ready", "error"]),
  version: Schema.Number,
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(100_000))),
}).annotate({ identifier: "CanvasResult" })
export type Result = Schema.Schema.Type<typeof Result>

export const ErrorCode = Schema.Literals([
  "cancelled",
  "disconnected",
  "invalid_request",
  "not_found",
  "timeout",
  "unsupported",
])
export type ErrorCode = Schema.Schema.Type<typeof ErrorCode>

export const Failure = Schema.Struct({
  code: ErrorCode,
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
}).annotate({ identifier: "CanvasFailure" })
export type Failure = Schema.Schema.Type<typeof Failure>

export const Event = {
  Requested: BusEvent.define("kilocode.canvas.requested", Request),
  Cancelled: BusEvent.define(
    "kilocode.canvas.cancelled",
    Schema.Struct({
      requestID: RequestID,
      sessionID: SessionID,
      reason: Schema.Literals(["cancelled", "disposed", "timeout"]),
    }),
  ),
}
