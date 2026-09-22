// raya_change - model-facing native desktop observation tool
import { Desktop, HostError, type Input } from "@/kilocode/desktop/service"
import { ObservationID } from "@/kilocode/computer-use/protocol"
import { Key, Modifier, ScrollDelta, WatchCount, WatchInterval } from "@/kilocode/desktop/protocol"
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
          yield* ctx.ask({ permission: "desktop_observe", patterns: ["foreground-window"], always: [], metadata: {} })
          const result = yield* run(desktop, { operation: "observe", sessionID: ctx.sessionID }, ctx.abort)
          if (result.operation !== "observe")
            return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          const summary = {
            width: result.width,
            height: result.height,
            observation: result.observation,
            receipt: result.receipt,
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
          yield* ctx.ask({ permission: "desktop_windows", patterns: ["visible-windows"], always: [], metadata: {} })
          const result = yield* run(desktop, { operation: "windows", sessionID: ctx.sessionID }, ctx.abort)
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
          yield* ctx.ask({
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
  frames: WatchCount.annotate({ description: "Number of sampled frames, from 2 through 4." }),
  interval_ms: WatchInterval.annotate({ description: "Delay between samples, from 250 through 2000 milliseconds." }),
})

export const DesktopWatchTool = Tool.define<typeof WatchParams, { frames: number }, Desktop.Service, "desktop_watch">(
  "desktop_watch",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Sample a short, bounded sequence of 2–4 foreground Windows application frames for live visual processing. Raya shows one visible cancellable capture indicator, stores each frame in this tool result, and sends no desktop input.",
      parameters: WatchParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const pattern = `foreground-window:${params.frames}x${params.interval_ms}ms`
          yield* ctx.ask({ permission: "desktop_watch", patterns: [pattern], always: [], metadata: {} })
          const result = yield* run(
            desktop,
            {
              operation: "watch",
              sessionID: ctx.sessionID,
              frameCount: params.frames,
              intervalMs: params.interval_ms,
            },
            ctx.abort,
          )
          if (result.operation !== "watch")
            return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return {
            title: `Captured ${result.frames.length} desktop frames`,
            output: JSON.stringify(
              {
                frames: result.frames.map((frame) => ({
                  width: frame.width,
                  height: frame.height,
                  observation: frame.observation,
                })),
                receipt: result.receipt,
              },
              undefined,
              2,
            ),
            metadata: { frames: result.frames.length },
            attachments: result.frames.map((frame, index) => ({
              type: "file" as const,
              mime: frame.mime,
              filename: `desktop-frame-${index + 1}.${frame.mime === "image/png" ? "png" : "jpg"}`,
              url: `data:${frame.mime};base64,${frame.data}`,
            })),
          }
        }),
    }
  }),
)

const Unit = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))
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
          yield* ctx.ask({ permission: "desktop_move", patterns: [point], always: [], metadata: {} })
          const result = yield* run(
            desktop,
            {
              operation: "move",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
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
          yield* ctx.ask({
            permission: "desktop_drag",
            patterns: [`${params.window_id}:${button}:${start}->${end}`],
            always: [],
            metadata: {},
          })
          const result = yield* run(
            desktop,
            {
              operation: "drag",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
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
          yield* ctx.ask({ permission: "desktop_click", patterns: [point], always: [], metadata: {} })
          const result = yield* run(
            desktop,
            {
              operation: "click",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
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
          yield* ctx.ask({
            permission: "desktop_type",
            patterns: [params.window_id],
            always: [],
            metadata: { length: params.text.length },
          })
          const result = yield* run(
            desktop,
            {
              operation: "type",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
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
          yield* ctx.ask({
            permission: "desktop_key",
            patterns: [`${params.window_id}:${chord}`],
            always: [],
            metadata: {},
          })
          const result = yield* run(
            desktop,
            {
              operation: "key",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
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
          yield* ctx.ask({ permission: "desktop_scroll", patterns: [amount], always: [], metadata: {} })
          const result = yield* run(
            desktop,
            {
              operation: "scroll",
              sessionID: ctx.sessionID,
              windowID: params.window_id,
              observationID: params.observation_id,
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
]
