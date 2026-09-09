// raya_change - Milestone F host-bridge browser protocol
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"

export const RequestID = Schema.String.pipe(Schema.brand("BrowserRequestID")).annotate({
  identifier: "BrowserRequestID",
})
export type RequestID = Schema.Schema.Type<typeof RequestID>

const Match = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000))
const Scope = { scope: Schema.optional(Match) }
export const Selector = Schema.Union([
  Match,
  Schema.Struct({ kind: Schema.Literal("role"), role: Match, name: Match, ...Scope }),
  Schema.Struct({ kind: Schema.Literal("label"), text: Match, ...Scope }),
  Schema.Struct({ kind: Schema.Literal("testid"), value: Match, ...Scope }),
]).annotate({
  description:
    "Observed legacy selector or exact semantic target. Optional scope is an observed selector matching one container. Ambiguous targets are rejected.",
})
const Url = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000))
const Text = Schema.String.check(Schema.isMaxLength(200_000))
export const TabID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).annotate({
  description: "Opaque observed browser tab identity; never infer from a tab index or URL.",
})
const Base = { id: RequestID, sessionID: SessionID, tabID: Schema.optional(TabID) }
export const TabsRequest = Schema.Union([
  Schema.Struct({ ...Base, operation: Schema.Literal("tabs"), action: Schema.Literal("list") }),
  Schema.Struct({ ...Base, operation: Schema.Literal("tabs"), action: Schema.Literal("open"), url: Url }),
  Schema.Struct({ ...Base, operation: Schema.Literal("tabs"), action: Schema.Literal("select"), tabID: TabID }),
  Schema.Struct({ ...Base, operation: Schema.Literal("tabs"), action: Schema.Literal("close"), tabID: TabID }),
])
export const Tab = Schema.Struct({
  id: TabID,
  url: Url,
  title: Schema.String,
  selected: Schema.Boolean,
  openerID: Schema.optional(TabID),
})
export const TabsResult = Schema.Struct({
  operation: Schema.Literal("tabs"),
  tabs: Schema.Array(Tab),
  tabID: Schema.optional(TabID),
  url: Schema.optional(Url),
  title: Schema.optional(Schema.String),
})

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
// raya_change start - Milestone G authenticated smoke walkthrough protocol
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const NavigateAction = Schema.Struct({ kind: Schema.Literal("navigate"), url: Url })
const ClickAction = Schema.Struct({ kind: Schema.Literal("click"), selector: Selector })
const TypeAction = Schema.Struct({
  kind: Schema.Literal("type"),
  selector: Selector,
  text: Text,
  submit: Schema.optional(Schema.Boolean),
})
const SelectAction = Schema.Struct({
  kind: Schema.Literal("select"),
  selector: Selector,
  values: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
})
export const SmokeAction = Schema.Union([NavigateAction, ClickAction, TypeAction, SelectAction])
export const SmokeAssertion = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("visible"),
    selector: Selector,
    text: Schema.optional(Text),
  }),
  Schema.Struct({
    kind: Schema.Literal("network"),
    url: Text,
    status: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("console"),
    level: Schema.optional(Schema.Literals(["error", "warning", "log", "info"])),
    message: Schema.optional(Text),
    max: Schema.Number,
  }),
])
export const SmokeStep = Schema.Struct({
  id: Name,
  title: Name,
  action: Schema.optional(SmokeAction),
  assertions: Schema.Array(SmokeAssertion).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
})
export const AuthCaptureRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("auth_capture"),
  name: Name,
})
export const SmokeRequest = Schema.Struct({
  ...Base,
  operation: Schema.Literal("smoke"),
  name: Name,
  mode: Schema.Literals(["scripted", "exploratory"]),
  steps: Schema.Array(SmokeStep).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
})
// raya_change end

export const Request = Schema.Union([
  TabsRequest,
  NavigateRequest,
  SnapshotRequest,
  ClickRequest,
  TypeRequest,
  SelectRequest,
  ScrollRequest,
  ScreenshotRequest,
  EvaluateRequest,
  AuthCaptureRequest,
  SmokeRequest,
]).annotate({ identifier: "BrowserRequest" })
export type Request = Schema.Schema.Type<typeof Request>

const ResultBase = {
  tabID: Schema.optional(TabID),
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
// raya_change start - Milestone G structured smoke evidence
export const AuthCaptureResult = Schema.Struct({
  ...ResultBase,
  operation: Schema.Literal("auth_capture"),
  name: Name,
  path: Schema.String,
  cookies: Schema.Number,
  origins: Schema.Number,
})
export const SmokeAssertionResult = Schema.Struct({
  kind: Schema.Literals(["visible", "network", "console"]),
  passed: Schema.Boolean,
  expected: Text,
  actual: Text,
})
export const SmokeStepResult = Schema.Struct({
  id: Name,
  title: Name,
  passed: Schema.Boolean,
  screenshot: Schema.String,
  assertions: Schema.Array(SmokeAssertionResult),
  error: Schema.optional(Text),
})
export const SmokeFinding = Schema.Struct({
  url: Schema.optional(Text),
  status: Schema.optional(Schema.Number),
  level: Schema.optional(Text),
  message: Schema.optional(Text),
})
export const SmokeResult = Schema.Struct({
  ...ResultBase,
  operation: Schema.Literal("smoke"),
  runID: Schema.String,
  name: Name,
  mode: Schema.Literals(["scripted", "exploratory"]),
  passed: Schema.Boolean,
  startedAt: Schema.Number,
  finishedAt: Schema.Number,
  artifact: Schema.String,
  authState: Schema.String,
  failingStep: Schema.optional(Name),
  steps: Schema.Array(SmokeStepResult),
  network: Schema.Array(SmokeFinding),
  console: Schema.Array(SmokeFinding),
})
// raya_change end

export const Result = Schema.Union([
  TabsResult,
  NavigateResult,
  SnapshotResult,
  ClickResult,
  TypeResult,
  SelectResult,
  ScrollResult,
  ScreenshotResult,
  EvaluateResult,
  AuthCaptureResult,
  SmokeResult,
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
