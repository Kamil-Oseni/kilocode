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
export const WatchCount = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(2),
  Schema.isLessThanOrEqualTo(4),
)
export const WatchInterval = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(250),
  Schema.isLessThanOrEqualTo(2_000),
)
export const ScrollDelta = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(-1_200),
  Schema.isLessThanOrEqualTo(1_200),
)
const Base = { id: RequestID, sessionID: SessionID }
export const Key = Schema.Union([
  Schema.Literals([
    "Backspace",
    "Tab",
    "Enter",
    "Escape",
    "Space",
    "PageUp",
    "PageDown",
    "End",
    "Home",
    "ArrowLeft",
    "ArrowUp",
    "ArrowRight",
    "ArrowDown",
    "Delete",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
  ]),
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]$/)),
])
export const Modifier = Schema.Literals(["alt", "control", "meta", "shift"])

export const ObserveRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("observe"),
})

export const WatchRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("watch"),
  frameCount: WatchCount,
  intervalMs: WatchInterval,
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

export const MoveRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("move"),
  windowID: Identity,
  observationID: ObservationID,
  x: Unit,
  y: Unit,
})

export const TypeRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("type"),
  windowID: Identity,
  observationID: ObservationID,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)),
})

export const KeyRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("key"),
  windowID: Identity,
  observationID: ObservationID,
  key: Key,
  modifiers: Schema.Array(Modifier).check(Schema.isMaxLength(4)),
})

export const ScrollRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("scroll"),
  windowID: Identity,
  observationID: ObservationID,
  deltaX: ScrollDelta,
  deltaY: ScrollDelta,
}).check(
  Schema.makeFilter((value) =>
    value.deltaX !== 0 || value.deltaY !== 0 ? undefined : "Desktop scroll requires non-zero movement.",
  ),
)

export const Request = Schema.Union([
  ObserveRequest,
  WatchRequest,
  MoveRequest,
  ClickRequest,
  TypeRequest,
  KeyRequest,
  ScrollRequest,
]).annotate({ identifier: "DesktopRequest" })
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

export const WatchFrame = Schema.Struct({
  width: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  mime: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000_000)),
  observation: Observation,
})

export const WatchResult = Schema.Struct({
  operation: Schema.Literal("watch"),
  frames: Schema.Array(WatchFrame).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
  receipt: Receipt,
})

export const ClickResult = Schema.Struct({
  operation: Schema.Literal("click"),
  receipt: Receipt,
})

export const MoveResult = Schema.Struct({
  operation: Schema.Literal("move"),
  receipt: Receipt,
})

export const TypeResult = Schema.Struct({
  operation: Schema.Literal("type"),
  receipt: Receipt,
})

export const KeyResult = Schema.Struct({
  operation: Schema.Literal("key"),
  receipt: Receipt,
})

export const ScrollResult = Schema.Struct({
  operation: Schema.Literal("scroll"),
  receipt: Receipt,
})

export const Result = Schema.Union([
  ObserveResult,
  WatchResult,
  MoveResult,
  ClickResult,
  TypeResult,
  KeyResult,
  ScrollResult,
]).annotate({ identifier: "DesktopResult" })
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
