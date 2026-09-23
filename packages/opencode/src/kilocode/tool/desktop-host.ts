// raya_change - model-facing native desktop observation tool
import { Desktop, HostError, type Input } from "@/kilocode/desktop/service"
import { ObservationID } from "@/kilocode/computer-use/protocol"
import {
  ActionClassification,
  type ActionClassification as Classification,
  type SensitiveCategory as SensitiveKind,
} from "@/kilocode/computer-use/lease"
import { Authorization, Key, Modifier, ScrollDelta, WatchCount, WatchInterval } from "@/kilocode/desktop/protocol"
import * as Tool from "@/tool/tool"
import { Effect, Schema } from "effect"

function abort(signal: AbortSignal) {
  return Effect.callback<never, HostError>((resume) => {
    const err = () => new HostError({ code: "cancelled", detail: "The desktop observation was cancelled" })
    if (signal.aborted) return resume(Effect.fail(err()))
    const handler = () => resume(Effect.fail(err()))
    signal.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", handler))
  })
}

function run(desktop: Desktop.Interface, input: Input, signal: AbortSignal) {
  return desktop.request(input).pipe(Effect.raceFirst(abort(signal)), Effect.orDie)
}

function classified(value: Classification): SensitiveKind | false {
  return value === "ordinary" ? false : value
}

function approve(
  desktop: Desktop.Interface,
  ctx: Tool.Context,
  input: Parameters<Tool.Context["ask"]>[0] & {
    action: "observe" | "pointer" | "keyboard" | "scroll" | "window"
    windowID?: string
    sensitive?: SensitiveKind | false
  },
) {
  return Effect.gen(function* () {
    const result = yield* run(
      desktop,
      {
        operation: "authorize",
        sessionID: ctx.sessionID,
        surface: "desktop",
        action: input.action,
        sensitive: input.sensitive ?? false,
        ...(input.windowID ? { windowID: input.windowID } : {}),
      },
      ctx.abort,
    )
    const auth =
      result.operation === "authorize" ? result : yield* Effect.die(new Error("Desktop host returned the wrong result"))
    if (auth.decision === "deny") yield* Effect.die(new Error(`Desktop control denied: ${auth.reason}`))
    if (auth.decision === "allow") {
      if (!auth.grantID) return yield* Effect.die(new Error("Desktop grant authorization omitted its grant identity"))
      return { kind: "grant" as const, grantID: auth.grantID }
    }
    if (auth.decision === "ask") {
      yield* ctx.ask({
        permission: input.permission,
        patterns: input.patterns,
        always: input.always,
        metadata: input.metadata,
      })
      return { kind: "prompt" as const }
    }
    return yield* Effect.die(new Error("Desktop host returned an invalid authorization decision"))
  })
}

const Params = Schema.Struct({})
export const DesktopObserveTool = Tool.define<typeof Params, { mime: string }, Desktop.Service, "desktop_observe">(
  "desktop_observe",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Capture the current foreground Windows application as an image visible to the model. Use it to inspect the desktop before any future desktop action; it does not send input.",
      parameters: Params,
      execute: (_params, ctx) =>
        Effect.gen(function* () {
          const authorization = yield* approve(desktop, ctx, {
            action: "observe",
            permission: "desktop_observe",
            patterns: ["foreground-window"],
            always: [],
            metadata: {},
          })
          const result = yield* run(
            desktop,
            { operation: "observe", sessionID: ctx.sessionID, authorization },
            ctx.abort,
          )
          if (result.operation !== "observe")
            return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          const summary = {
            width: result.width,
            height: result.height,
            observation: result.observation,
            receipt: result.receipt,
            timing: result.timing,
            ...(result.semantics ? { semantics: result.semantics } : {}),
          }
          return {
            title: "Desktop observation",
            output: JSON.stringify(summary, undefined, 2),
            metadata: { mime: result.mime },
            attachments: [
              {
                type: "file" as const,
                mime: result.mime,
                filename: result.mime === "image/png" ? "desktop.png" : "desktop.jpg",
                url: `data:${result.mime};base64,${result.data}`,
              },
            ],
          }
        }),
    }
  }),
)

export const DesktopWindowsTool = Tool.define<typeof Params, { count: number }, Desktop.Service, "desktop_windows">(
  "desktop_windows",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "List up to 64 visible Windows application windows with opaque IDs, titles, process IDs, bounds, minimized state, and foreground state. The result includes a fresh single-use observation required by desktop_focus; it sends no input.",
      parameters: Params,
      execute: (_params, ctx) =>
        Effect.gen(function* () {
          const authorization = yield* approve(desktop, ctx, {
            action: "observe",
            permission: "desktop_windows",
            patterns: ["visible-windows"],
            always: [],
            metadata: {},
          })
          const result = yield* run(
            desktop,
            { operation: "windows", sessionID: ctx.sessionID, authorization },
            ctx.abort,
          )
          if (result.operation !== "windows")
            return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return {
            title: `Found ${result.windows.length} visible desktop windows`,
            output: JSON.stringify(result, undefined, 2),
            metadata: { count: result.windows.length },
          }
        }),
    }
  }),
)

const FocusParams = Schema.Struct({
  window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Exact opaque window identity returned by desktop_windows.",
  }),
  observation_id: ObservationID.annotate({
    description: "Fresh desktop_windows observation ID. It can be used only once.",
  }),
  sensitive_category: ActionClassification,
})

export const DesktopFocusTool = Tool.define<typeof FocusParams, {}, Desktop.Service, "desktop_focus">(
  "desktop_focus",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Bring one exact visible application window to the foreground using a fresh desktop_windows result. The host refuses stale or changed window lists, missing targets, reuse, and manual takeover before dispatch. Observe the focused window afterward before any other action.",
      parameters: FocusParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const authorization = yield* approve(desktop, ctx, {
            action: "window",
            windowID: params.window_id,
            sensitive: classified(params.sensitive_category),
            permission: "desktop_focus",
            patterns: [params.window_id],
            always: [],
            metadata: {},
          })
          const result = yield* run(
            desktop,
            {
              operation: "focus",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
              sensitive: classified(params.sensitive_category),
              authorization,
            },
            ctx.abort,
          )
          if (result.operation !== "focus")
            return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return {
            title: "Focused desktop window",
            output: JSON.stringify({ receipt: result.receipt }, undefined, 2),
            metadata: {},
          }
        }),
    }
  }),
)

const WatchParams = Schema.Struct({
  frames: WatchCount.annotate({ description: "Maximum sampled frames, from 2 through 16." }),
  interval_ms: WatchInterval.annotate({
    description: "Maximum idle delay from 50 through 1000 milliseconds; changed scenes sample every 50 milliseconds.",
  }),
}).check(
  Schema.makeFilter((input) =>
    input.frames * 500 + (input.frames - 1) * input.interval_ms <= 10_000
      ? undefined
      : "Desktop watch exceeds the ten-second local capture budget",
  ),
)

export const DesktopWatchTool = Tool.define<typeof WatchParams, { frames: number }, Desktop.Service, "desktop_watch">(
  "desktop_watch",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Adaptively sample a bounded sequence of 2–16 foreground Windows application frames for live visual processing. Changed scenes sample every 50 milliseconds while stable scenes back off to the requested idle interval. The estimated local watch must fit ten seconds. Raya shows one visible cancellable capture indicator, stores each frame in this tool result, and sends no desktop input.",
      parameters: WatchParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const pattern = `foreground-window:${params.frames}x${params.interval_ms}ms`
          const authorization = yield* approve(desktop, ctx, {
            action: "observe",
            permission: "desktop_watch",
            patterns: [pattern],
            always: [],
            metadata: {},
          })
          const result = yield* run(
            desktop,
            {
              operation: "watch",
              sessionID: ctx.sessionID,
              frameCount: params.frames,
              intervalMs: params.interval_ms,
              authorization,
            },
            ctx.abort,
          )
          if (result.operation !== "watch")
            return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          const images = result.frames.filter((frame) => frame.change === "keyframe").length
          return {
            title: `Observed ${result.frames.length} desktop frames (${images} image${images === 1 ? "" : "s"})`,
            output: JSON.stringify(
              {
                frames: result.frames.map((frame) => ({
                  change: frame.change,
                  width: frame.width,
                  height: frame.height,
                  ...(frame.change === "unchanged" ? { baseObservationID: frame.baseObservationID } : {}),
                  observation: frame.observation,
                  timing: frame.timing,
                  ...(frame.semantics ? { semantics: frame.semantics } : {}),
                })),
                receipt: result.receipt,
              },
              undefined,
              2,
            ),
            metadata: { frames: result.frames.length, images },
            attachments: result.frames.flatMap((frame, index) =>
              frame.change === "keyframe"
                ? [
                    {
                      type: "file" as const,
                      mime: frame.mime,
                      filename: `desktop-frame-${index + 1}.${frame.mime === "image/png" ? "png" : "jpg"}`,
                      url: `data:${frame.mime};base64,${frame.data}`,
                    },
                  ]
                : [],
            ),
          }
        }),
    }
  }),
)

const Unit = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))
const Sensitive = ActionClassification
const ClickParams = Schema.Struct({
  window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Exact opaque window identity returned by desktop_observe.",
  }),
  observation_id: ObservationID.annotate({
    description: "Fresh observation ID returned by desktop_observe. It can be used only once.",
  }),
  x: Unit.annotate({ description: "Horizontal position normalized from 0 at the left to 1 at the right." }),
  y: Unit.annotate({ description: "Vertical position normalized from 0 at the top to 1 at the bottom." }),
  action: Schema.optional(Schema.Literals(["click", "double_click"])).annotate({
    description: "Defaults to a single click.",
  }),
  button: Schema.optional(Schema.Literals(["left", "right"])).annotate({ description: "Defaults to left." }),
  sensitive_category: Sensitive,
})

const MoveParams = Schema.Struct({
  window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Exact opaque window identity returned by desktop_observe.",
  }),
  observation_id: ObservationID.annotate({
    description: "Fresh observation ID returned by desktop_observe. It can be used only once.",
  }),
  x: Unit.annotate({ description: "Horizontal position normalized from 0 at the left to 1 at the right." }),
  y: Unit.annotate({ description: "Vertical position normalized from 0 at the top to 1 at the bottom." }),
  sensitive_category: Sensitive,
})

export const DesktopMoveTool = Tool.define<typeof MoveParams, {}, Desktop.Service, "desktop_move">(
  "desktop_move",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Move the pointer to exact normalized coordinates in the foreground window, for hover and pointer targeting, grounded by a fresh desktop_observe result. The host refuses changed windows, stale observations, reuse, and manual takeover before dispatch.",
      parameters: MoveParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const point = `${params.window_id}:${params.x.toFixed(4)},${params.y.toFixed(4)}`
          const authorization = yield* approve(desktop, ctx, {
            action: "pointer",
            windowID: params.window_id,
            sensitive: classified(params.sensitive_category),
            permission: "desktop_move",
            patterns: [point],
            always: [],
            metadata: {},
          })
          const result = yield* run(
            desktop,
            {
              operation: "move",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
              sensitive: classified(params.sensitive_category),
              authorization,
              x: params.x,
              y: params.y,
            },
            ctx.abort,
          )
          if (result.operation !== "move") return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return {
            title: "Moved desktop pointer",
            output: JSON.stringify({ receipt: result.receipt }, undefined, 2),
            metadata: {},
          }
        }),
    }
  }),
)

const DragParams = Schema.Struct({
  window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Exact opaque window identity returned by desktop_observe.",
  }),
  observation_id: ObservationID.annotate({
    description: "Fresh observation ID returned by desktop_observe. It can be used only once.",
  }),
  start_x: Unit.annotate({ description: "Normalized horizontal drag start." }),
  start_y: Unit.annotate({ description: "Normalized vertical drag start." }),
  end_x: Unit.annotate({ description: "Normalized horizontal drag end." }),
  end_y: Unit.annotate({ description: "Normalized vertical drag end." }),
  button: Schema.optional(Schema.Literals(["left", "right"])).annotate({ description: "Defaults to left." }),
  sensitive_category: Sensitive,
}).check(
  Schema.makeFilter((value) =>
    value.start_x !== value.end_x || value.start_y !== value.end_y
      ? undefined
      : "Desktop drag requires different start and end points.",
  ),
)

export const DesktopDragTool = Tool.define<typeof DragParams, {}, Desktop.Service, "desktop_drag">(
  "desktop_drag",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Drag between two exact normalized points in the foreground window, grounded by a fresh desktop_observe result. The Windows host batches button down, absolute movement, and button up, and sends a recovery release if native dispatch is incomplete.",
      parameters: DragParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const start = `${params.start_x.toFixed(4)},${params.start_y.toFixed(4)}`
          const end = `${params.end_x.toFixed(4)},${params.end_y.toFixed(4)}`
          const button = params.button ?? "left"
          const authorization = yield* approve(desktop, ctx, {
            action: "pointer",
            windowID: params.window_id,
            permission: "desktop_drag",
            patterns: [`${params.window_id}:${button}:${start}->${end}`],
            always: [],
            metadata: {},
            sensitive: classified(params.sensitive_category),
          })
          const result = yield* run(
            desktop,
            {
              operation: "drag",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
              sensitive: classified(params.sensitive_category),
              authorization,
              startX: params.start_x,
              startY: params.start_y,
              endX: params.end_x,
              endY: params.end_y,
              button,
            },
            ctx.abort,
          )
          if (result.operation !== "drag") return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return {
            title: "Dragged on desktop",
            output: JSON.stringify({ receipt: result.receipt }, undefined, 2),
            metadata: {},
          }
        }),
    }
  }),
)

export const DesktopClickTool = Tool.define<typeof ClickParams, {}, Desktop.Service, "desktop_click">(
  "desktop_click",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Click exact normalized coordinates in the foreground window grounded by a fresh desktop_observe result. The host refuses changed windows, stale observations, reuse, and manual takeover before dispatch.",
      parameters: ClickParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const point = `${params.window_id}:${params.x.toFixed(4)},${params.y.toFixed(4)}`
          const authorization = yield* approve(desktop, ctx, {
            action: "pointer",
            windowID: params.window_id,
            permission: "desktop_click",
            patterns: [point],
            always: [],
            metadata: {},
            sensitive: classified(params.sensitive_category),
          })
          const result = yield* run(
            desktop,
            {
              operation: "click",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
              sensitive: classified(params.sensitive_category),
              authorization,
              action: params.action ?? "click",
              button: params.button ?? "left",
              x: params.x,
              y: params.y,
            },
            ctx.abort,
          )
          if (result.operation !== "click")
            return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return {
            title: params.action === "double_click" ? "Double-clicked desktop" : "Clicked desktop",
            output: JSON.stringify({ receipt: result.receipt }, undefined, 2),
            metadata: {},
          }
        }),
    }
  }),
)

const TypeParams = Schema.Struct({
  window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Exact opaque window identity returned by desktop_observe.",
  }),
  observation_id: ObservationID.annotate({
    description: "Fresh observation ID returned by desktop_observe. It can be used only once.",
  }),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)).annotate({
    description: "Text to insert at the current focus. The host does not put this text on the clipboard.",
  }),
  sensitive_category: Sensitive,
})

export const DesktopTypeTool = Tool.define<typeof TypeParams, {}, Desktop.Service, "desktop_type">(
  "desktop_type",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Insert text at the current focus in the foreground window grounded by a fresh desktop_observe result. The host refuses changed windows, stale observations, reuse, and manual takeover before dispatch.",
      parameters: TypeParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const authorization = yield* approve(desktop, ctx, {
            action: "keyboard",
            windowID: params.window_id,
            permission: "desktop_type",
            patterns: [params.window_id],
            always: [],
            metadata: { length: params.text.length },
            sensitive: classified(params.sensitive_category),
          })
          const result = yield* run(
            desktop,
            {
              operation: "type",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
              sensitive: classified(params.sensitive_category),
              authorization,
              text: params.text,
            },
            ctx.abort,
          )
          if (result.operation !== "type") return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return {
            title: "Typed into desktop",
            output: JSON.stringify({ receipt: result.receipt }, undefined, 2),
            metadata: {},
          }
        }),
    }
  }),
)

const KeyParams = Schema.Struct({
  window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Exact opaque window identity returned by desktop_observe.",
  }),
  observation_id: ObservationID.annotate({
    description: "Fresh observation ID returned by desktop_observe. It can be used only once.",
  }),
  key: Key.annotate({
    description: "Named navigation/function key, or one ASCII letter or digit.",
  }),
  modifiers: Schema.optional(Schema.Array(Modifier).check(Schema.isMaxLength(4))).annotate({
    description: "Optional Alt, Control, Meta, or Shift modifiers.",
  }),
  sensitive_category: Sensitive,
})

export const DesktopKeyTool = Tool.define<typeof KeyParams, {}, Desktop.Service, "desktop_key">(
  "desktop_key",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Press one bounded key or key chord in the foreground window grounded by a fresh desktop_observe result. The host refuses changed windows, stale observations, reuse, and manual takeover before dispatch.",
      parameters: KeyParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const modifiers = [...new Set(params.modifiers ?? [])]
          const chord = [...modifiers, params.key].join("+")
          const authorization = yield* approve(desktop, ctx, {
            action: "keyboard",
            windowID: params.window_id,
            permission: "desktop_key",
            patterns: [`${params.window_id}:${chord}`],
            always: [],
            metadata: {},
            sensitive: classified(params.sensitive_category),
          })
          const result = yield* run(
            desktop,
            {
              operation: "key",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
              sensitive: classified(params.sensitive_category),
              authorization,
              key: params.key,
              modifiers,
            },
            ctx.abort,
          )
          if (result.operation !== "key") return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return {
            title: `Pressed ${chord}`,
            output: JSON.stringify({ receipt: result.receipt }, undefined, 2),
            metadata: {},
          }
        }),
    }
  }),
)

const ScrollParams = Schema.Struct({
  window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Exact opaque window identity returned by desktop_observe.",
  }),
  observation_id: ObservationID.annotate({
    description: "Fresh observation ID returned by desktop_observe. It can be used only once.",
  }),
  delta_x: Schema.optional(ScrollDelta).annotate({
    description: "Horizontal Windows wheel delta from -1200 through 1200. Defaults to 0.",
  }),
  delta_y: ScrollDelta.annotate({
    description: "Vertical Windows wheel delta from -1200 through 1200. At least one delta must be non-zero.",
  }),
  sensitive_category: Sensitive,
}).check(
  Schema.makeFilter((value) =>
    (value.delta_x ?? 0) !== 0 || value.delta_y !== 0 ? undefined : "Desktop scroll requires non-zero movement.",
  ),
)

export const DesktopScrollTool = Tool.define<typeof ScrollParams, {}, Desktop.Service, "desktop_scroll">(
  "desktop_scroll",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Scroll the foreground window by bounded horizontal and vertical wheel deltas grounded by a fresh desktop_observe result. The host refuses changed windows, stale observations, reuse, and manual takeover before dispatch.",
      parameters: ScrollParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const x = params.delta_x ?? 0
          const amount = `${params.window_id}:${x},${params.delta_y}`
          const authorization = yield* approve(desktop, ctx, {
            action: "scroll",
            windowID: params.window_id,
            sensitive: classified(params.sensitive_category),
            permission: "desktop_scroll",
            patterns: [amount],
            always: [],
            metadata: {},
          })
          const result = yield* run(
            desktop,
            {
              operation: "scroll",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
              sensitive: classified(params.sensitive_category),
              authorization,
              deltaX: x,
              deltaY: params.delta_y,
            },
            ctx.abort,
          )
          if (result.operation !== "scroll")
            return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return {
            title: "Scrolled desktop",
            output: JSON.stringify({ receipt: result.receipt }, undefined, 2),
            metadata: {},
          }
        }),
    }
  }),
)

const SequenceControl = Schema.Struct({
  kind: Schema.Literal("control"),
  control_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  enabled: Schema.optional(Schema.Boolean),
  focused: Schema.optional(Schema.Boolean),
  selected: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((value) =>
    value.enabled !== undefined || value.focused !== undefined || value.selected !== undefined
      ? undefined
      : "A control condition requires an expected state.",
  ),
)
const SequencePostcondition = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pixels"), change: Schema.Literals(["changed", "unchanged"]) }),
  SequenceControl,
])
const SequenceAction = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("pointer"),
    action: Schema.Literals(["move", "click", "double_click"]),
    window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    sensitive_category: Sensitive,
    x: Unit,
    y: Unit,
    button: Schema.optional(Schema.Literals(["left", "right"])),
  }),
  Schema.Struct({
    operation: Schema.Literal("drag"),
    window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    sensitive_category: Sensitive,
    start_x: Unit,
    start_y: Unit,
    end_x: Unit,
    end_y: Unit,
    button: Schema.optional(Schema.Literals(["left", "right"])),
  }),
  Schema.Struct({
    operation: Schema.Literal("type"),
    window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    sensitive_category: Sensitive,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)),
  }),
  Schema.Struct({
    operation: Schema.Literal("key"),
    window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    sensitive_category: Sensitive,
    key: Key,
    modifiers: Schema.optional(Schema.Array(Modifier).check(Schema.isMaxLength(4))),
  }),
  Schema.Struct({
    operation: Schema.Literal("scroll"),
    window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    sensitive_category: Sensitive,
    delta_x: Schema.optional(ScrollDelta),
    delta_y: ScrollDelta,
  }),
])
const SequenceParams = Schema.Struct({
  window_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Exact foreground window identity from the starting desktop observation.",
  }),
  observation_id: ObservationID.annotate({
    description: "Fresh version-2 desktop observation that grounds the first action.",
  }),
  max_duration_ms: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(100),
    Schema.isLessThanOrEqualTo(10_000),
  ),
  steps: Schema.Array(
    Schema.Struct({
      action: SequenceAction,
      preconditions: Schema.optional(Schema.Array(SequenceControl).check(Schema.isMaxLength(4))),
      postconditions: Schema.Array(SequencePostcondition).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
      recovery: Schema.Literal("stop"),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
})

function condition(value: Schema.Schema.Type<typeof SequenceControl>) {
  return {
    kind: value.kind,
    controlID: value.control_id,
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(value.focused === undefined ? {} : { focused: value.focused }),
    ...(value.selected === undefined ? {} : { selected: value.selected }),
  }
}

function planned(value: Schema.Schema.Type<typeof SequenceAction>) {
  const base = { windowID: value.window_id, sensitive: classified(value.sensitive_category) }
  if (value.operation === "pointer")
    return {
      ...base,
      operation: "pointer" as const,
      action: value.action,
      x: value.x,
      y: value.y,
      ...(value.button ? { button: value.button } : {}),
    }
  if (value.operation === "drag")
    return {
      ...base,
      operation: "drag" as const,
      startX: value.start_x,
      startY: value.start_y,
      endX: value.end_x,
      endY: value.end_y,
      button: value.button ?? "left",
    }
  if (value.operation === "type") return { ...base, operation: "type" as const, text: value.text }
  if (value.operation === "key")
    return { ...base, operation: "key" as const, key: value.key, modifiers: [...new Set(value.modifiers ?? [])] }
  return { ...base, operation: "scroll" as const, deltaX: value.delta_x ?? 0, deltaY: value.delta_y }
}

export const DesktopSequenceTool = Tool.define<
  typeof SequenceParams,
  { completed: number; status: "completed" | "stopped" },
  Desktop.Service,
  "desktop_sequence"
>(
  "desktop_sequence",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Execute 1â€“8 ordered actions in the same foreground Windows application without a model round trip between actions. Every action is checked against the active grant immediately before dispatch and must satisfy bounded local control or pixel postconditions before the next action can run. The host stops on mismatch, takeover, timeout, target change, denial, or unknown outcome and never retries automatically.",
      parameters: SequenceParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const steps = params.steps.map((step) => ({
            action: planned(step.action),
            preconditions: (step.preconditions ?? []).map(condition),
            postconditions: step.postconditions.map((item) => (item.kind === "control" ? condition(item) : item)),
            recovery: step.recovery,
          }))
          const proofs = new Map<string, Schema.Schema.Type<typeof Authorization>>()
          for (const step of steps) {
            const action = step.action
            const kind =
              action.operation === "scroll"
                ? ("scroll" as const)
                : action.operation === "type" || action.operation === "key"
                  ? ("keyboard" as const)
                  : ("pointer" as const)
            const key = JSON.stringify([kind, action.windowID, action.sensitive])
            if (proofs.has(key)) continue
            const authorization = yield* approve(desktop, ctx, {
              action: kind,
              windowID: action.windowID,
              sensitive: action.sensitive,
              permission: "desktop_sequence",
              patterns: [`${action.windowID}:${kind}:${action.sensitive || "ordinary"}`],
              always: [],
              metadata: { steps: steps.length },
            })
            proofs.set(key, authorization)
          }
          const plans = steps.map((step) => {
            const action = step.action
            const kind =
              action.operation === "scroll"
                ? ("scroll" as const)
                : action.operation === "type" || action.operation === "key"
                  ? ("keyboard" as const)
                  : ("pointer" as const)
            const key = JSON.stringify([kind, action.windowID, action.sensitive])
            const authorization = proofs.get(key)
            if (!authorization) throw new Error("Desktop sequence authorization evidence is incomplete")
            return { ...step, action: { ...action, authorization } }
          })
          const result = yield* run(
            desktop,
            {
              operation: "sequence",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
              maxDurationMs: params.max_duration_ms,
              steps: plans,
            },
            ctx.abort,
          )
          if (result.operation !== "sequence")
            return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return {
            title: `Desktop sequence ${result.status} after ${result.completed} action${result.completed === 1 ? "" : "s"}`,
            output: JSON.stringify(
              {
                status: result.status,
                completed: result.completed,
                ...(result.reason ? { reason: result.reason } : {}),
                observation: result.observation,
                evidence: result.evidence,
                timing: result.timing,
                ...(result.semantics ? { semantics: result.semantics } : {}),
                receipt: result.receipt,
              },
              undefined,
              2,
            ),
            metadata: { completed: result.completed, status: result.status },
            attachments: [
              {
                type: "file" as const,
                mime: result.mime,
                filename: result.mime === "image/png" ? "desktop-sequence.png" : "desktop-sequence.jpg",
                url: `data:${result.mime};base64,${result.data}`,
              },
            ],
          }
        }),
    }
  }),
)

export const DesktopTools = [
  DesktopObserveTool,
  DesktopWindowsTool,
  DesktopFocusTool,
  DesktopWatchTool,
  DesktopMoveTool,
  DesktopDragTool,
  DesktopClickTool,
  DesktopTypeTool,
  DesktopKeyTool,
  DesktopScrollTool,
  DesktopSequenceTool,
]
