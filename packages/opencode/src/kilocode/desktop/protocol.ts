// raya_change - native desktop observation host protocol
import { BusEvent } from "@/bus/bus-event"
import { Observation, ObservationID, Receipt } from "@/kilocode/computer-use/protocol"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"

export const RequestID = Schema.String.pipe(Schema.brand("DesktopRequestID")).annotate({
  identifier: "DesktopRequestID",
})
export type RequestID = Schema.Schema.Type<typeof RequestID>

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const Unit = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))
const Base = { id: RequestID, sessionID: SessionID }

export const ObserveRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("observe"),
})

export const ClickRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("click"),
  windowID: Identity,
  observationID: ObservationID,
  action: Schema.Literals(["click", "double_click"]),
  x: Unit,
  y: Unit,
  button: Schema.Literals(["left", "right"]),
})

export const Request = Schema.Union([ObserveRequest, ClickRequest]).annotate({ identifier: "DesktopRequest" })
export type Request = Schema.Schema.Type<typeof Request>

export const ObserveResult = Schema.Struct({
  operation: Schema.Literal("observe"),
  width: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  mime: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000_000)),
  observation: Observation,
  receipt: Receipt,
})

export const ClickResult = Schema.Struct({
  operation: Schema.Literal("click"),
  receipt: Receipt,
})

export const Result = Schema.Union([ObserveResult, ClickResult]).annotate({ identifier: "DesktopResult" })
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
