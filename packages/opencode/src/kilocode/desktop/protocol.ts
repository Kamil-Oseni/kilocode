// raya_change - native desktop observation host protocol
import { BusEvent } from "@/bus/bus-event"
import { Observation, ObservationID, Receipt } from "@/kilocode/computer-use/protocol"
import { Action as LeaseAction, GrantID, SensitiveCategory } from "@/kilocode/computer-use/lease"
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
  Schema.isLessThanOrEqualTo(16),
)
export const WatchInterval = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(50),
  Schema.isLessThanOrEqualTo(1_000),
)
export const ScrollDelta = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(-1_200),
  Schema.isLessThanOrEqualTo(1_200),
)
const Base = { id: RequestID, sessionID: SessionID }
const Sensitive = Schema.Union([Schema.Boolean, SensitiveCategory])
const ClassifiedSensitive = Schema.Union([Schema.Literal(false), SensitiveCategory])
export const Delegation = Schema.Struct({
  parentSessionID: SessionID,
  childSessionID: SessionID,
  grantID: GrantID,
  windowID: Schema.optional(Identity),
  identity: Schema.optional(Identity),
})
export const Authorization = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("grant"), grantID: GrantID, delegation: Schema.optional(Delegation) }),
  Schema.Struct({ kind: Schema.Literal("prompt"), delegation: Schema.optional(Delegation) }),
])
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
  authorization: Schema.optional(Authorization),
})

export const WindowsRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("windows"),
  authorization: Schema.optional(Authorization),
})

export const WatchRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("watch"),
  authorization: Schema.optional(Authorization),
  frameCount: WatchCount,
  intervalMs: WatchInterval,
}).check(
  Schema.makeFilter((input) =>
    input.frameCount * 500 + (input.frameCount - 1) * input.intervalMs <= 10_000
      ? undefined
      : "Desktop watch exceeds the ten-second local capture budget",
  ),
)

export const AuthorizeRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("authorize"),
  surface: Schema.Literal("desktop"),
  action: LeaseAction,
  windowID: Schema.optional(Identity),
  sensitive: Sensitive,
  delegation: Schema.optional(Delegation),
  admission: Schema.optional(Schema.Literal("computer_child")),
})

export const ClickRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("click"),
  windowID: Identity,
  observationID: ObservationID,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
  action: Schema.Literals(["click", "double_click"]),
  x: Unit,
  y: Unit,
  button: Schema.Literals(["left", "right"]),
})

export const FocusRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("focus"),
  windowID: Identity,
  observationID: ObservationID,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
})

export const MoveRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("move"),
  windowID: Identity,
  observationID: ObservationID,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
  x: Unit,
  y: Unit,
})

export const DragRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("drag"),
  windowID: Identity,
  observationID: ObservationID,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
  startX: Unit,
  startY: Unit,
  endX: Unit,
  endY: Unit,
  button: Schema.Literals(["left", "right"]),
}).check(
  Schema.makeFilter((value) =>
    value.startX !== value.endX || value.startY !== value.endY
      ? undefined
      : "Desktop drag requires different start and end points.",
  ),
)

export const TypeRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("type"),
  windowID: Identity,
  observationID: ObservationID,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)),
})

export const KeyRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("key"),
  windowID: Identity,
  observationID: ObservationID,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
  key: Key,
  modifiers: Schema.Array(Modifier).check(Schema.isMaxLength(4)),
})

export const ScrollRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("scroll"),
  windowID: Identity,
  observationID: ObservationID,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
  deltaX: ScrollDelta,
  deltaY: ScrollDelta,
}).check(
  Schema.makeFilter((value) =>
    value.deltaX !== 0 || value.deltaY !== 0 ? undefined : "Desktop scroll requires non-zero movement.",
  ),
)

const SequencePointer = Schema.Struct({
  operation: Schema.Literal("pointer"),
  action: Schema.Literals(["move", "click", "double_click"]),
  windowID: Identity,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
  x: Unit,
  y: Unit,
  button: Schema.optional(Schema.Literals(["left", "right"])),
})

const SequenceDrag = Schema.Struct({
  operation: Schema.Literal("drag"),
  windowID: Identity,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
  startX: Unit,
  startY: Unit,
  endX: Unit,
  endY: Unit,
  button: Schema.Literals(["left", "right"]),
}).check(
  Schema.makeFilter((value) =>
    value.startX !== value.endX || value.startY !== value.endY
      ? undefined
      : "Desktop drag requires different start and end points.",
  ),
)

const SequenceType = Schema.Struct({
  operation: Schema.Literal("type"),
  windowID: Identity,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)),
})

const SequenceKey = Schema.Struct({
  operation: Schema.Literal("key"),
  windowID: Identity,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
  key: Key,
  modifiers: Schema.Array(Modifier).check(Schema.isMaxLength(4)),
})

const SequenceScroll = Schema.Struct({
  operation: Schema.Literal("scroll"),
  windowID: Identity,
  sensitive: ClassifiedSensitive,
  authorization: Schema.optional(Authorization),
  deltaX: ScrollDelta,
  deltaY: ScrollDelta,
}).check(
  Schema.makeFilter((value) =>
    value.deltaX !== 0 || value.deltaY !== 0 ? undefined : "Desktop scroll requires non-zero movement.",
  ),
)

export const SequenceAction = Schema.Union([SequencePointer, SequenceDrag, SequenceType, SequenceKey, SequenceScroll])

export const SequencePrecondition = Schema.Struct({
  kind: Schema.Literal("control"),
  controlID: Identity,
  enabled: Schema.optional(Schema.Boolean),
  focused: Schema.optional(Schema.Boolean),
  selected: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((value) =>
    value.enabled !== undefined || value.focused !== undefined || value.selected !== undefined
      ? undefined
      : "Desktop control precondition requires an expected state.",
  ),
)

export const SequencePostcondition = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pixels"), change: Schema.Literals(["changed", "unchanged"]) }),
  SequencePrecondition,
])

export const SequenceStep = Schema.Struct({
  action: SequenceAction,
  preconditions: Schema.Array(SequencePrecondition).check(Schema.isMaxLength(4)),
  postconditions: Schema.Array(SequencePostcondition).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  recovery: Schema.Literal("stop"),
})

export const SequenceRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("sequence"),
  windowID: Identity,
  observationID: ObservationID,
  maxDurationMs: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(100),
    Schema.isLessThanOrEqualTo(10_000),
  ),
  steps: Schema.Array(SequenceStep).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
})

export const Request = Schema.Union([
  AuthorizeRequest,
  ObserveRequest,
  WindowsRequest,
  WatchRequest,
  FocusRequest,
  MoveRequest,
  DragRequest,
  ClickRequest,
  TypeRequest,
  KeyRequest,
  ScrollRequest,
  SequenceRequest,
]).annotate({ identifier: "DesktopRequest" })
export type Request = Schema.Schema.Type<typeof Request>

export const AuthorizeResult = Schema.Struct({
  operation: Schema.Literal("authorize"),
  decision: Schema.Literals(["allow", "ask", "deny"]),
  reason: Identity,
  grantID: Schema.optional(GrantID),
  windowID: Schema.optional(Identity),
  identity: Schema.optional(Identity),
})

export const Timing = Schema.Struct({
  acquisitionMs: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  preparationMs: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  semanticsMs: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  totalMs: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
})

export const SemanticControl = Schema.Struct({
  controlID: Identity,
  role: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  automationID: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  x: Schema.Number.check(Schema.isInt()),
  y: Schema.Number.check(Schema.isInt()),
  width: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  enabled: Schema.Boolean,
  focused: Schema.Boolean,
  selected: Schema.optional(Schema.Boolean),
  actions: Schema.Array(Schema.Literals(["invoke", "select", "toggle", "expand_collapse", "value", "scroll"])).check(
    Schema.isMaxLength(6),
  ),
})

export const Semantics = Schema.Struct({
  source: Schema.Literal("windows_ui_automation"),
  status: Schema.Literals(["available", "unavailable"]),
  viewport: Schema.Struct({
    x: Schema.Number.check(Schema.isInt()),
    y: Schema.Number.check(Schema.isInt()),
    width: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    height: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  }),
  controls: Schema.Array(SemanticControl).check(Schema.isMaxLength(256)),
  truncated: Schema.Boolean,
})

export const ObserveResult = Schema.Struct({
  operation: Schema.Literal("observe"),
  width: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  mime: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000_000)),
  timing: Timing,
  semantics: Schema.optional(Semantics),
  observation: Observation,
  receipt: Receipt,
})

export const Window = Schema.Struct({
  windowID: Identity,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
  processID: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  x: Schema.Number.check(Schema.isInt()),
  y: Schema.Number.check(Schema.isInt()),
  width: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  minimized: Schema.Boolean,
  foreground: Schema.Boolean,
})

export const WindowsResult = Schema.Struct({
  operation: Schema.Literal("windows"),
  windows: Schema.Array(Window).check(Schema.isMaxLength(64)),
  observation: Observation,
  receipt: Receipt,
})

const WatchFrameBase = {
  width: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  timing: Timing,
  semantics: Schema.optional(Semantics),
  observation: Observation,
}

export const WatchFrame = Schema.Union([
  Schema.Struct({
    ...WatchFrameBase,
    change: Schema.Literal("keyframe"),
    mime: Schema.Literals(["image/png", "image/jpeg"]),
    data: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000_000)),
  }),
  Schema.Struct({
    ...WatchFrameBase,
    change: Schema.Literal("unchanged"),
    baseObservationID: ObservationID,
  }),
])

export const WatchResult = Schema.Struct({
  operation: Schema.Literal("watch"),
  frames: Schema.Array(WatchFrame).check(Schema.isMinLength(2), Schema.isMaxLength(16)),
  receipt: Receipt,
})

export const ClickResult = Schema.Struct({
  operation: Schema.Literal("click"),
  receipt: Receipt,
})

export const FocusResult = Schema.Struct({
  operation: Schema.Literal("focus"),
  receipt: Receipt,
})

export const MoveResult = Schema.Struct({
  operation: Schema.Literal("move"),
  receipt: Receipt,
})

export const DragResult = Schema.Struct({
  operation: Schema.Literal("drag"),
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

export const SequenceEvidence = Schema.Struct({
  step: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(8)),
  observationID: ObservationID,
  sceneVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  observedAt: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  postconditions: Schema.Array(SequencePostcondition).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
})

export const SequenceResult = Schema.Struct({
  operation: Schema.Literal("sequence"),
  status: Schema.Literals(["completed", "stopped"]),
  completed: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8)),
  reason: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000))),
  width: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  mime: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000_000)),
  timing: Timing,
  semantics: Schema.optional(Semantics),
  observation: Observation,
  evidence: Schema.Array(SequenceEvidence).check(Schema.isMaxLength(8)),
  receipt: Receipt,
})

export const Result = Schema.Union([
  AuthorizeResult,
  ObserveResult,
  WindowsResult,
  WatchResult,
  FocusResult,
  MoveResult,
  DragResult,
  ClickResult,
  TypeResult,
  KeyResult,
  ScrollResult,
  SequenceResult,
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
