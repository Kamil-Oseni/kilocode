// raya_change - Milestone F model-facing browser tools
import { Browser, HostError } from "@/kilocode/browser/service"
import type { Input } from "@/kilocode/browser/service"
import type { Result } from "@/kilocode/browser/protocol"
import * as Tool from "@/tool/tool"
import { Effect, Schema } from "effect"

const Selector = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000))
const Text = Schema.String.check(Schema.isMaxLength(200_000))
const LIMIT = 100_000

function abort(signal: AbortSignal) {
  return Effect.callback<never, HostError>((resume) => {
    const err = () => new HostError({ code: "cancelled", detail: "The browser tool call was cancelled" })
    if (signal.aborted) return resume(Effect.fail(err()))
    const handler = () => resume(Effect.fail(err()))
    signal.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", handler))
  })
}

function render(result: Result) {
  if (result.operation === "screenshot")
    return `Captured ${result.mime} screenshot for ${result.url ?? "the current page"}.`
  const text =
    result.operation === "evaluate"
      ? result.output
      : JSON.stringify(result, (key, value) => (key === "data" ? undefined : value), 2)
  if (text.length <= LIMIT) return text
  return `${text.slice(0, LIMIT)}\n\n[Browser result truncated by ${text.length - LIMIT} characters]`
}

function run(browser: Browser.Interface, input: Input, signal: AbortSignal) {
  return browser.request(input).pipe(Effect.raceFirst(abort(signal)), Effect.orDie)
}

const NavigateParams = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
    description: "Absolute URL to open in the shared browser.",
  }),
})
export const BrowserNavigateTool = Tool.define<
  typeof NavigateParams,
  { url?: string },
  Browser.Service,
  "browser_navigate"
>(
  "browser_navigate",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description: "Navigate the shared in-editor browser to a URL and return the resulting page state.",
      parameters: NavigateParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser_navigate", patterns: [params.url], always: [params.url], metadata: {} })
          const result = yield* run(
            browser,
            { operation: "navigate", sessionID: ctx.sessionID, url: params.url },
            ctx.abort,
          )
          return {
            title: `Browser: ${result.url ?? params.url}`,
            output: render(result),
            metadata: { url: result.url },
          }
        }),
    }
  }),
)

const SnapshotParams = Schema.Struct({})
export const BrowserSnapshotTool = Tool.define<
  typeof SnapshotParams,
  { url?: string },
  Browser.Service,
  "browser_snapshot"
>(
  "browser_snapshot",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description:
        "Return an accessibility-oriented snapshot of the current page in the shared in-editor browser. Use its selectors to ground later browser actions.",
      parameters: SnapshotParams,
      execute: (_params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser_snapshot", patterns: ["*"], always: ["*"], metadata: {} })
          const result = yield* run(browser, { operation: "snapshot", sessionID: ctx.sessionID }, ctx.abort)
          return { title: "Browser snapshot", output: render(result), metadata: { url: result.url } }
        }),
    }
  }),
)

const ClickParams = Schema.Struct({ selector: Selector })
export const BrowserClickTool = Tool.define<typeof ClickParams, { url?: string }, Browser.Service, "browser_click">(
  "browser_click",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description: "Click an element in the shared browser using a selector from the latest browser snapshot.",
      parameters: ClickParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_click",
            patterns: [params.selector],
            always: [params.selector],
            metadata: {},
          })
          const result = yield* run(
            browser,
            { operation: "click", sessionID: ctx.sessionID, selector: params.selector },
            ctx.abort,
          )
          return { title: `Clicked ${params.selector}`, output: render(result), metadata: { url: result.url } }
        }),
    }
  }),
)

const TypeParams = Schema.Struct({
  selector: Selector,
  text: Text,
  submit: Schema.optional(Schema.Boolean).annotate({ description: "Press Enter after typing. Defaults to false." }),
})
export const BrowserTypeTool = Tool.define<typeof TypeParams, { url?: string }, Browser.Service, "browser_type">(
  "browser_type",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description: "Replace the text in an editable browser element and optionally submit it with Enter.",
      parameters: TypeParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_type",
            patterns: [params.selector],
            always: [params.selector],
            metadata: { selector: params.selector },
          })
          const result = yield* run(
            browser,
            {
              operation: "type",
              sessionID: ctx.sessionID,
              selector: params.selector,
              text: params.text,
              submit: params.submit === true,
            },
            ctx.abort,
          )
          return { title: `Typed into ${params.selector}`, output: render(result), metadata: { url: result.url } }
        }),
    }
  }),
)

const SelectParams = Schema.Struct({
  selector: Selector,
  values: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
})
export const BrowserSelectTool = Tool.define<typeof SelectParams, { url?: string }, Browser.Service, "browser_select">(
  "browser_select",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description: "Select one or more values in a browser select element.",
      parameters: SelectParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_select",
            patterns: [params.selector],
            always: [params.selector],
            metadata: {},
          })
          const result = yield* run(
            browser,
            { operation: "select", sessionID: ctx.sessionID, selector: params.selector, values: params.values },
            ctx.abort,
          )
          return { title: `Selected ${params.selector}`, output: render(result), metadata: { url: result.url } }
        }),
    }
  }),
)

const ScrollParams = Schema.Struct({
  delta_x: Schema.optional(Schema.Number).annotate({ description: "Horizontal pixels. Defaults to 0." }),
  delta_y: Schema.Number.annotate({ description: "Vertical pixels; positive scrolls down." }),
  selector: Schema.optional(Selector).annotate({ description: "Optional scrollable element selector." }),
})
export const BrowserScrollTool = Tool.define<typeof ScrollParams, { url?: string }, Browser.Service, "browser_scroll">(
  "browser_scroll",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description: "Scroll the current browser page or a selected scrollable element by pixel deltas.",
      parameters: ScrollParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const pattern = params.selector ?? "*"
          yield* ctx.ask({ permission: "browser_scroll", patterns: [pattern], always: [pattern], metadata: {} })
          const result = yield* run(
            browser,
            {
              operation: "scroll",
              sessionID: ctx.sessionID,
              deltaX: params.delta_x ?? 0,
              deltaY: params.delta_y,
              selector: params.selector,
            },
            ctx.abort,
          )
          return { title: "Scrolled browser", output: render(result), metadata: { url: result.url } }
        }),
    }
  }),
)

const ScreenshotParams = Schema.Struct({
  full_page: Schema.optional(Schema.Boolean).annotate({ description: "Capture the full page. Defaults to false." }),
})
export const BrowserScreenshotTool = Tool.define<
  typeof ScreenshotParams,
  { url?: string; mime: string },
  Browser.Service,
  "browser_screenshot"
>(
  "browser_screenshot",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description: "Capture the current shared browser page as an image visible to the model.",
      parameters: ScreenshotParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser_screenshot", patterns: ["*"], always: ["*"], metadata: {} })
          const result = yield* run(
            browser,
            { operation: "screenshot", sessionID: ctx.sessionID, fullPage: params.full_page === true },
            ctx.abort,
          )
          if (result.operation !== "screenshot")
            return yield* Effect.die(new Error("Browser host returned the wrong result"))
          return {
            title: "Browser screenshot",
            output: render(result),
            metadata: { url: result.url, mime: result.mime },
            attachments: [
              {
                type: "file" as const,
                mime: result.mime,
                filename: result.mime === "image/png" ? "browser.png" : "browser.jpg",
                url: `data:${result.mime};base64,${result.data}`,
              },
            ],
          }
        }),
    }
  }),
)

const EvaluateParams = Schema.Struct({
  expression: Text.annotate({ description: "JavaScript expression or function body to evaluate in the current page." }),
})
export const BrowserEvaluateTool = Tool.define<
  typeof EvaluateParams,
  { url?: string },
  Browser.Service,
  "browser_evaluate"
>(
  "browser_evaluate",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description:
        "Evaluate JavaScript in the current browser page and return a bounded serialized result. Prefer snapshot-grounded actions for normal interaction.",
      parameters: EvaluateParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser_evaluate", patterns: ["*"], always: ["*"], metadata: {} })
          const result = yield* run(
            browser,
            { operation: "evaluate", sessionID: ctx.sessionID, expression: params.expression },
            ctx.abort,
          )
          return { title: "Browser evaluation", output: render(result), metadata: { url: result.url } }
        }),
    }
  }),
)

export const BrowserTools = [
  BrowserNavigateTool,
  BrowserSnapshotTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserSelectTool,
  BrowserScrollTool,
  BrowserScreenshotTool,
  BrowserEvaluateTool,
]
