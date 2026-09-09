// raya_change - Milestone F model-facing browser tools
import { Browser, HostError } from "@/kilocode/browser/service"
import type { Input } from "@/kilocode/browser/service"
import { TabID, Selector, SmokeStep, type Result } from "@/kilocode/browser/protocol"
import * as Tool from "@/tool/tool"
import { Effect, Schema } from "effect"

const Text = Schema.String.check(Schema.isMaxLength(200_000))
const Identity = { tab_id: TabID }
const Bootstrap = { tab_id: Schema.optional(TabID) }
const LIMIT = 100_000

function target(value: typeof Selector.Type) {
  return typeof value === "string" ? value : JSON.stringify(value)
}

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
    return `Tab ${result.tabID ?? "unknown"}: captured ${result.mime} screenshot for ${result.url ?? "the current page"}.`
  const text =
    result.operation === "evaluate"
      ? `Tab ${result.tabID ?? "unknown"}:\n${result.output}`
      : JSON.stringify(result, (key, value) => (key === "data" ? undefined : value), 2)
  if (text.length <= LIMIT) return text
  return `${text.slice(0, LIMIT)}\n\n[Browser result truncated by ${text.length - LIMIT} characters]`
}

function run(browser: Browser.Interface, input: Input, signal: AbortSignal) {
  return browser.request(input).pipe(Effect.raceFirst(abort(signal)), Effect.orDie)
}

const NavigateParams = Schema.Struct({
  ...Bootstrap,
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
      description:
        "Navigate the shared in-editor browser to a URL and return the resulting page state. Use automatically when the user asks to open, browse, visit, or inspect a website.",
      parameters: NavigateParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser_navigate", patterns: [params.url], always: [params.url], metadata: {} })
          const result = yield* run(
            browser,
            { operation: "navigate", tabID: params.tab_id, sessionID: ctx.sessionID, url: params.url },
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

const SnapshotParams = Schema.Struct({ ...Bootstrap })
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
        "Return an accessibility-oriented snapshot of the current page in the shared in-editor browser. Use automatically to look at or inspect a website, and use its selectors to ground later browser actions.",
      parameters: SnapshotParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser_snapshot", patterns: ["*"], always: ["*"], metadata: {} })
          const result = yield* run(
            browser,
            { operation: "snapshot", tabID: params.tab_id, sessionID: ctx.sessionID },
            ctx.abort,
          )
          return { title: "Browser snapshot", output: render(result), metadata: { url: result.url } }
        }),
    }
  }),
)

const ClickParams = Schema.Struct({ ...Identity, selector: Selector })
export const BrowserClickTool = Tool.define<typeof ClickParams, { url?: string }, Browser.Service, "browser_click">(
  "browser_click",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description:
        "Click an observed target using an exact role/name, label, test ID, or legacy selector. Ambiguous semantic targets are rejected; scope to an observed container when needed.",
      parameters: ClickParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_click",
            patterns: [target(params.selector)],
            always: [target(params.selector)],
            metadata: {},
          })
          const result = yield* run(
            browser,
            { operation: "click", tabID: params.tab_id, sessionID: ctx.sessionID, selector: params.selector },
            ctx.abort,
          )
          return { title: `Clicked ${target(params.selector)}`, output: render(result), metadata: { url: result.url } }
        }),
    }
  }),
)

const TypeParams = Schema.Struct({
  ...Identity,
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
            patterns: [target(params.selector)],
            always: [target(params.selector)],
            metadata: { selector: params.selector },
          })
          const result = yield* run(
            browser,
            {
              operation: "type",
              tabID: params.tab_id,
              sessionID: ctx.sessionID,
              selector: params.selector,
              text: params.text,
              submit: params.submit === true,
            },
            ctx.abort,
          )
          return {
            title: `Typed into ${target(params.selector)}`,
            output: render(result),
            metadata: { url: result.url },
          }
        }),
    }
  }),
)

const SelectParams = Schema.Struct({
  ...Identity,
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
            patterns: [target(params.selector)],
            always: [target(params.selector)],
            metadata: {},
          })
          const result = yield* run(
            browser,
            {
              operation: "select",
              tabID: params.tab_id,
              sessionID: ctx.sessionID,
              selector: params.selector,
              values: params.values,
            },
            ctx.abort,
          )
          return { title: `Selected ${target(params.selector)}`, output: render(result), metadata: { url: result.url } }
        }),
    }
  }),
)

const ScrollParams = Schema.Struct({
  ...Identity,
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
          const pattern = params.selector === undefined ? "*" : target(params.selector)
          yield* ctx.ask({ permission: "browser_scroll", patterns: [pattern], always: [pattern], metadata: {} })
          const result = yield* run(
            browser,
            {
              operation: "scroll",
              tabID: params.tab_id,
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
  ...Bootstrap,
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
            {
              operation: "screenshot",
              tabID: params.tab_id,
              sessionID: ctx.sessionID,
              fullPage: params.full_page === true,
            },
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
  ...Identity,
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
            { operation: "evaluate", tabID: params.tab_id, sessionID: ctx.sessionID, expression: params.expression },
            ctx.abort,
          )
          return { title: "Browser evaluation", output: render(result), metadata: { url: result.url } }
        }),
    }
  }),
)

// raya_change start - Milestone G authenticated walkthrough and structured smoke evidence tools
const AuthCaptureParams = Schema.Struct({
  ...Identity,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Stable target-app name used to save and later reuse authenticated Playwright storage state.",
  }),
})
export const BrowserAuthCaptureTool = Tool.define<
  typeof AuthCaptureParams,
  { path?: string; cookies?: number; origins?: number },
  Browser.Service,
  "browser_auth_capture"
>(
  "browser_auth_capture",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description:
        "Capture the current logged-in browser session as Playwright storageState for authenticated smoke runs.",
      parameters: AuthCaptureParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_auth_capture",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })
          const result = yield* run(
            browser,
            { operation: "auth_capture", tabID: params.tab_id, sessionID: ctx.sessionID, name: params.name },
            ctx.abort,
          )
          if (result.operation !== "auth_capture")
            return yield* Effect.die(new Error("Browser host returned the wrong auth capture result"))
          return {
            title: `Captured authenticated browser state for ${params.name}`,
            output: render(result),
            metadata: { path: result.path, cookies: result.cookies, origins: result.origins },
          }
        }),
    }
  }),
)

const SmokeParams = Schema.Struct({
  ...Identity,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  mode: Schema.optional(Schema.Literals(["scripted", "exploratory"])).annotate({
    description: "Use exploratory when the agent derived this walkthrough dynamically. Defaults to scripted.",
  }),
  steps: Schema.Array(SmokeStep).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
})
export const BrowserSmokeTestTool = Tool.define<
  typeof SmokeParams,
  { passed: boolean; runID: string; artifact: string; failingStep?: string },
  Browser.Service,
  "browser_smoke_test"
>(
  "browser_smoke_test",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description:
        "Run an authenticated browser walkthrough with per-step screenshots and visible-state plus network or console assertions. Use this automatically for plain-English requests to test like a real user, run a walkthrough, UX test, smoke test, or end-to-end browser check. Derive exploratory steps from the user intent and live page instead of asking the user to name tools. The first run captures current authentication automatically when no saved state exists. A failed assertion returns passed=false and the exact failing step.",
      parameters: SmokeParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_smoke_test",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })
          const result = yield* run(
            browser,
            {
              operation: "smoke",
              tabID: params.tab_id,
              sessionID: ctx.sessionID,
              name: params.name,
              mode: params.mode ?? "scripted",
              steps: params.steps,
            },
            ctx.abort,
          )
          if (result.operation !== "smoke")
            return yield* Effect.die(new Error("Browser host returned the wrong smoke result"))
          return {
            title: result.passed
              ? `Smoke test passed: ${result.name}`
              : `Smoke test failed at ${result.failingStep ?? "an unknown step"}: ${result.name}`,
            output: render(result),
            metadata: {
              passed: result.passed,
              runID: result.runID,
              artifact: result.artifact,
              failingStep: result.failingStep,
              evidence: "raya-smoke-v1",
            },
          }
        }),
    }
  }),
)
// raya_change end

const TabsParams = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literal("open"),
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  }),
  Schema.Struct({ action: Schema.Literal("select"), ...Identity }),
  Schema.Struct({ action: Schema.Literal("close"), ...Identity }),
])
export const BrowserTabsTool = Tool.define<typeof TabsParams, { url?: string }, Browser.Service, "browser_tabs">(
  "browser_tabs",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description:
        "List observed stable tab IDs and popup opener ownership, open a new tab, select a tab for viewing, or close an observed tab. Popups never silently replace the selected tab. Use returned IDs for subsequent browser tools.",
      parameters: TabsParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_tabs",
            patterns: [params.action],
            always: [params.action],
            metadata: {},
          })
          const input =
            params.action === "open"
              ? { operation: "tabs" as const, action: params.action, url: params.url, sessionID: ctx.sessionID }
              : params.action === "list"
                ? { operation: "tabs" as const, action: params.action, sessionID: ctx.sessionID }
                : { operation: "tabs" as const, action: params.action, tabID: params.tab_id, sessionID: ctx.sessionID }
          const result = yield* run(browser, input, ctx.abort)
          return { title: "Browser tabs", output: render(result), metadata: { url: result.url } }
        }),
    }
  }),
)

export const BrowserTools = [
  BrowserTabsTool,
  BrowserNavigateTool,
  BrowserSnapshotTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserSelectTool,
  BrowserScrollTool,
  BrowserScreenshotTool,
  BrowserEvaluateTool,
  BrowserAuthCaptureTool,
  BrowserSmokeTestTool,
]
