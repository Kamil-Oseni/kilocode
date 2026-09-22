// raya_change - native desktop observation host protocol
import { BusEvent } from "@/bus/bus-event"
import { Observation, Receipt } from "@/kilocode/computer-use/protocol"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"

export const RequestID = Schema.String.pipe(Schema.brand("DesktopRequestID")).annotate({
  identifier: "DesktopRequestID",
})
export type RequestID = Schema.Schema.Type<typeof RequestID>

export const Request = Schema.Struct({
  id: RequestID,
  sessionID: SessionID,
  operation: Schema.Literal("observe"),
}).annotate({ identifier: "DesktopRequest" })
export type Request = Schema.Schema.Type<typeof Request>

export const Result = Schema.Struct({
  operation: Schema.Literal("observe"),
  width: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  mime: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000_000)),
  observation: Observation,
  receipt: Receipt,
}).annotate({ identifier: "DesktopResult" })
export type Result = Schema.Schema.Type<typeof Result>

export const ErrorCode = Schema.Literals(["cancelled", "disconnected", "invalid_request", "timeout", "unsupported"])
export type ErrorCode = Schema.Schema.Type<typeof ErrorCode>

export const Failure = Schema.Struct({
  code: ErrorCode,
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
  receipt: Schema.optional(Receipt),
}).annotate({ identifier: "DesktopFailure" })
export type Failure = Schema.Schema.Type<typeof Failure>

export const Event = {
  Requested: BusEvent.define("kilocode.desktop.requested", Request),
  Cancelled: BusEvent.define(
    "kilocode.desktop.cancelled",
    Schema.Struct({
      requestID: RequestID,
      sessionID: SessionID,
      reason: Schema.Literals(["cancelled", "disposed", "timeout"]),
    }),
  ),
}
