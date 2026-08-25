// raya_change - Milestone F host-bridge browser protocol
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"

export const RequestID = Schema.String.pipe(Schema.brand("BrowserRequestID")).annotate({
  identifier: "BrowserRequestID",
})
export type RequestID = Schema.Schema.Type<typeof RequestID>

const Selector = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000))
const Url = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000))
const Text = Schema.String.check(Schema.isMaxLength(200_000))
const Base = { id: RequestID, sessionID: SessionID }

export const NavigateRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("navigate"),
  url: Url,
})
export const SnapshotRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("snapshot"),
})
export const ClickRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("click"),
  selector: Selector,
})
export const TypeRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("type"),
  selector: Selector,
  text: Text,
  submit: Schema.Boolean,
})
export const SelectRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("select"),
  selector: Selector,
  values: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
})
export const ScrollRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("scroll"),
  deltaX: Schema.Number,
  deltaY: Schema.Number,
  selector: Schema.optional(Selector),
})
export const ScreenshotRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("screenshot"),
  fullPage: Schema.Boolean,
})
export const EvaluateRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("evaluate"),
  expression: Text,
})

export const Request = Schema.Union([
  NavigateRequest,
  SnapshotRequest,
  ClickRequest,
  TypeRequest,
  SelectRequest,
  ScrollRequest,
  ScreenshotRequest,
  EvaluateRequest,
]).annotate({ identifier: "BrowserRequest" })
export type Request = Schema.Schema.Type<typeof Request>

const ResultBase = {
  url: Schema.optional(Url),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(10_000))),
}
const ActionResult = <Operation extends "navigate" | "click" | "type" | "select" | "scroll">(operation: Operation) =>
  Schema.Struct({
    ...ResultBase,
    operation: Schema.Literal(operation),
    snapshot: Schema.optional(Text),
  })

export const NavigateResult = ActionResult("navigate")
export const SnapshotResult = Schema.Struct({
  ...ResultBase,
  operation: Schema.Literal("snapshot"),
  snapshot: Text,
})
export const ClickResult = ActionResult("click")
export const TypeResult = ActionResult("type")
export const SelectResult = ActionResult("select")
export const ScrollResult = ActionResult("scroll")
export const ScreenshotResult = Schema.Struct({
  ...ResultBase,
  operation: Schema.Literal("screenshot"),
  mime: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String.check(Schema.isMaxLength(20_000_000)),
})
export const EvaluateResult = Schema.Struct({
  ...ResultBase,
  operation: Schema.Literal("evaluate"),
  output: Text,
})

export const Result = Schema.Union([
  NavigateResult,
  SnapshotResult,
  ClickResult,
  TypeResult,
  SelectResult,
  ScrollResult,
  ScreenshotResult,
  EvaluateResult,
]).annotate({ identifier: "BrowserResult" })
export type Result = Schema.Schema.Type<typeof Result>

export const ErrorCode = Schema.Literals([
  "cancelled",
  "closed",
  "disconnected",
  "evaluation_failed",
  "invalid_request",
  "navigation_failed",
  "not_found",
  "timeout",
  "unsupported",
])
export type ErrorCode = Schema.Schema.Type<typeof ErrorCode>

export const Failure = Schema.Struct({
  code: ErrorCode,
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
}).annotate({ identifier: "BrowserFailure" })
export type Failure = Schema.Schema.Type<typeof Failure>

export const Event = {
  Requested: BusEvent.define("kilocode.browser.requested", Request),
  Cancelled: BusEvent.define(
    "kilocode.browser.cancelled",
    Schema.Struct({
      requestID: RequestID,
      sessionID: SessionID,
      reason: Schema.Literals(["cancelled", "disposed", "timeout"]),
    }),
  ),
}
