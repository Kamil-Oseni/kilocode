// raya_change - model-facing native desktop tool tests
import { expect, test } from "bun:test"
import { GrantID } from "@/kilocode/computer-use/lease"
import { ObservationID } from "@/kilocode/computer-use/protocol"
import { DragRequest, Key, ScrollRequest, SequenceRequest, WatchRequest } from "@/kilocode/desktop/protocol"
import { Desktop } from "@/kilocode/desktop/service"
import {
  DesktopClickTool,
  DesktopDragTool,
  DesktopFocusTool,
  DesktopKeyTool,
  DesktopMoveTool,
  DesktopScrollTool,
  DesktopSequenceTool,
  DesktopTypeTool,
  DesktopWatchTool,
  DesktopWindowsTool,
} from "@/kilocode/tool/desktop-host"
import { MessageID, SessionID } from "@/session/schema"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Agent } from "@/agent/agent"
import * as KiloAgent from "@/kilocode/agent"
import { Permission } from "@/permission"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(Agent.node), AppNodeBuilder.build(Truncate.node)))

test("keeps legacy per-action approval as the fail-closed VS Code fallback", () => {
  const client = process.env.KILO_CLIENT
  process.env.KILO_CLIENT = "vscode"
  try {
    const rules = KiloAgent.prepare({}).defaultsPatch
    for (const permission of [
      "desktop_observe",
      "desktop_windows",
      "desktop_focus",
      "desktop_watch",
      "desktop_move",
      "desktop_drag",
      "desktop_click",
      "desktop_type",
      "desktop_key",
      "desktop_scroll",
      "desktop_sequence",
    ]) {
      expect(Permission.evaluate(permission, "*", rules).action).toBe("ask")
    }
  } finally {
    if (client === undefined) delete process.env.KILO_CLIENT
    else process.env.KILO_CLIENT = client
  }
})

it.instance("lists visible windows and focuses one exact observed target", () =>
  Effect.gen(function* () {
    const calls: Desktop.Input[] = []
    const asks: Parameters<Tool.Context["ask"]>[0][] = []
    const observation = {
      version: 1 as const,
      id: ObservationID.make("observation_windows"),
      observedAt: 1,
      validUntil: 10_000,
      target: { surface: "desktop" as const, windowID: "visible-windows", location: "catalog" },
    }
    const host: Desktop.Interface = {
      request: (input) =>
        Effect.sync(() => {
          calls.push(input)
          if (input.operation === "authorize")
            return { operation: "authorize" as const, decision: "ask" as const, reason: "No active grant" }
          if (input.operation === "windows")
            return {
              operation: "windows" as const,
              windows: [
                {
                  windowID: "window_seen",
                  title: "Editor",
                  processID: 5,
                  x: 0,
                  y: 0,
                  width: 1280,
                  height: 720,
                  minimized: false,
                  foreground: true,
                },
              ],
              observation,
              receipt: {
                version: 1 as const,
                requestID: "desktop_windows_test",
                startedAt: 1,
                finishedAt: 2,
                effect: "observe" as const,
                outcome: "confirmed" as const,
                target: observation.target,
                observationID: observation.id,
              },
            }
          return {
            operation: "focus" as const,
            receipt: {
              version: 1 as const,
              requestID: "desktop_focus_test",
              startedAt: 1,
              finishedAt: 2,
              effect: "manage" as const,
              outcome: "confirmed" as const,
              target: { surface: "desktop" as const, windowID: "window_seen" },
              observationID: observation.id,
            },
          }
        }),
      list: () => Effect.succeed([]),
      cancelSession: () => Effect.void,
      reply: () => Effect.void,
      reject: () => Effect.void,
    }
    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_desktop_windows"),
      messageID: MessageID.make("msg_desktop_windows"),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: (input) => Effect.sync(() => asks.push(input)),
    }
    const listed = yield* DesktopWindowsTool.pipe(
      Effect.provideService(Desktop.Service, host),
      Effect.flatMap(Tool.init),
      Effect.flatMap((tool) => tool.execute({}, ctx)),
    )
    const focused = yield* DesktopFocusTool.pipe(
      Effect.provideService(Desktop.Service, host),
      Effect.flatMap(Tool.init),
      Effect.flatMap((tool) =>
        tool.execute({ window_id: "window_seen", observation_id: observation.id, sensitive_category: "ordinary" }, ctx),
      ),
    )

    expect(asks).toEqual([
      expect.objectContaining({ permission: "desktop_windows", patterns: ["visible-windows"], always: [] }),
      expect.objectContaining({ permission: "desktop_focus", patterns: ["window_seen"], always: [] }),
    ])
    expect(calls.filter((input) => input.operation !== "authorize")).toEqual([
      { operation: "windows", sessionID: ctx.sessionID },
      {
        operation: "focus",
        sessionID: ctx.sessionID,
        windowID: "window_seen",
        observationID: observation.id,
        sensitive: false,
      },
    ])
    expect(listed.title).toBe("Found 1 visible desktop windows")
    expect(listed.output).not.toContain("pid:5;")
    expect(focused.title).toBe("Focused desktop window")
  }),
)

it.instance(
  "skips the per-action prompt only when the host authorizes an active grant",
  () =>
    Effect.gen(function* () {
      const calls: Desktop.Input[] = []
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const host: Desktop.Interface = {
        request: (input) =>
          Effect.sync(() => {
            calls.push(input)
            if (input.operation === "authorize")
              return {
                operation: "authorize" as const,
                decision: "allow" as const,
                reason: "Authorized by active grant",
                grantID: GrantID.make("grant_test"),
              }
            return {
              operation: "click" as const,
              receipt: {
                version: 1 as const,
                requestID: "desktop_click_granted",
                startedAt: 1,
                finishedAt: 2,
                effect: "interact" as const,
                outcome: "confirmed" as const,
                target: { surface: "desktop" as const, windowID: "window_seen" },
                observationID: ObservationID.make("observation_granted"),
              },
            }
          }),
        list: () => Effect.succeed([]),
        cancelSession: () => Effect.void,
        reply: () => Effect.void,
        reject: () => Effect.void,
      }
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_desktop_granted"),
        messageID: MessageID.make("msg_desktop_granted"),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (input) => Effect.sync(() => asks.push(input)),
      }
      yield* DesktopClickTool.pipe(
        Effect.provideService(Desktop.Service, host),
        Effect.flatMap(Tool.init),
        Effect.flatMap((tool) =>
          tool.execute(
            {
              window_id: "window_seen",
              observation_id: ObservationID.make("observation_granted"),
              x: 0.5,
              y: 0.5,
              sensitive_category: "communications",
            },
            ctx,
          ),
        ),
      )

      expect(asks).toEqual([])
      expect(calls.map((input) => input.operation)).toEqual(["authorize", "click"])
      expect(calls[0]).toMatchObject({ operation: "authorize", sensitive: "communications" })
      expect(calls[1]).toMatchObject({ operation: "click", sensitive: "communications" })
    }),
  { git: true },
)

it.instance("submits one bounded desktop plan after grouping lease decisions", () =>
  Effect.gen(function* () {
    const calls: Desktop.Input[] = []
    const asks: Parameters<Tool.Context["ask"]>[0][] = []
    const observation = {
      version: 2 as const,
      id: ObservationID.make("observation_sequence_final"),
      sequence: 3,
      sceneVersion: 3,
      observedAt: 3,
      validUntil: 10_000,
      target: { surface: "desktop" as const, windowID: "window_seen", location: "same-window" },
    }
    const host: Desktop.Interface = {
      request: (input) =>
        Effect.sync(() => {
          calls.push(input)
          if (input.operation === "authorize")
            return { operation: "authorize" as const, decision: "ask" as const, reason: "No active grant" }
          return {
            operation: "sequence" as const,
            status: "completed" as const,
            completed: 2,
            width: 20,
            height: 10,
            mime: "image/png" as const,
            data: "cG5n",
            timing: { acquisitionMs: 1, preparationMs: 1, totalMs: 2 },
            observation,
            evidence: [
              {
                step: 1,
                observationID: ObservationID.make("observation_sequence_2"),
                sceneVersion: 2,
                observedAt: 2,
                postconditions: [{ kind: "pixels" as const, change: "changed" as const }],
              },
              {
                step: 2,
                observationID: observation.id,
                sceneVersion: 3,
                observedAt: 3,
                postconditions: [{ kind: "control" as const, controlID: "editor", focused: true }],
              },
            ],
            receipt: {
              version: 1 as const,
              requestID: "desktop_sequence_test",
              startedAt: 1,
              finishedAt: 3,
              effect: "interact" as const,
              outcome: "confirmed" as const,
              target: observation.target,
              observationID: observation.id,
            },
          }
        }),
      list: () => Effect.succeed([]),
      cancelSession: () => Effect.void,
      reply: () => Effect.void,
      reject: () => Effect.void,
    }
    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_desktop_sequence"),
      messageID: MessageID.make("msg_desktop_sequence"),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: (input) => Effect.sync(() => asks.push(input)),
    }
    const result = yield* DesktopSequenceTool.pipe(
      Effect.provideService(Desktop.Service, host),
      Effect.flatMap(Tool.init),
      Effect.flatMap((tool) =>
        tool.execute(
          {
            window_id: "window_seen",
            observation_id: ObservationID.make("observation_sequence_1"),
            max_duration_ms: 5_000,
            steps: [
              {
                action: {
                  operation: "pointer",
                  action: "click",
                  window_id: "window_seen",
                  sensitive_category: "ordinary",
                  x: 0.5,
                  y: 0.5,
                },
                preconditions: [{ kind: "control", control_id: "editor", enabled: true }],
                postconditions: [{ kind: "pixels", change: "changed" }],
                recovery: "stop",
              },
              {
                action: {
                  operation: "type",
                  window_id: "window_seen",
                  sensitive_category: "communications",
                  text: "hello",
                },
                postconditions: [{ kind: "control", control_id: "editor", focused: true }],
                recovery: "stop",
              },
            ],
          },
          ctx,
        ),
      ),
    )

    expect(asks).toEqual([
      expect.objectContaining({ permission: "desktop_sequence", patterns: ["window_seen:pointer:ordinary"] }),
      expect.objectContaining({
        permission: "desktop_sequence",
        patterns: ["window_seen:keyboard:communications"],
      }),
    ])
    expect(calls.map((input) => input.operation)).toEqual(["authorize", "authorize", "sequence"])
    expect(calls[2]).toMatchObject({
      operation: "sequence",
      maxDurationMs: 5_000,
      steps: [
        {
          action: { operation: "pointer", sensitive: false },
          preconditions: [{ kind: "control", controlID: "editor", enabled: true }],
        },
        { action: { operation: "type", sensitive: "communications" } },
      ],
    })
    expect(result).toMatchObject({
      title: "Desktop sequence completed after 2 actions",
      metadata: { status: "completed", completed: 2 },
      attachments: [{ filename: "desktop-sequence.png" }],
    })
    expect(JSON.parse(result.output)).toMatchObject({ status: "completed", evidence: [{ step: 1 }, { step: 2 }] })
    expect(
      Schema.is(SequenceRequest)({
        id: "sequence_schema",
        sessionID: ctx.sessionID,
        operation: "sequence",
        windowID: "window_seen",
        observationID: ObservationID.make("observation_sequence_schema"),
        maxDurationMs: 10_001,
        steps: [],
      }),
    ).toBe(false)
  }),
)

it.instance(
  "desktop click forwards exact grounding and asks for the exact point",
  () =>
    Effect.gen(function* () {
      const calls: Desktop.Input[] = []
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const host: Desktop.Interface = {
        request: (input) =>
          Effect.sync(() => {
            calls.push(input)
            if (input.operation === "authorize")
              return { operation: "authorize" as const, decision: "ask" as const, reason: "No active grant" }
            if (input.operation === "watch") {
              return {
                operation: "watch" as const,
                frames: Array.from({ length: input.frameCount }, (_, index) => {
                  const frame = {
                    width: 20,
                    height: 10,
                    timing: { acquisitionMs: 5, preparationMs: 7, totalMs: 20 },
                    observation: {
                      version: 1 as const,
                      id: ObservationID.make(`observation_watch_${index}`),
                      observedAt: index + 1,
                      validUntil: index + 10_000,
                      target: { surface: "desktop" as const, windowID: "window_seen" },
                    },
                  }
                  if (index === 1)
                    return {
                      ...frame,
                      change: "unchanged" as const,
                      baseObservationID: ObservationID.make("observation_watch_0"),
                    }
                  return { ...frame, change: "keyframe" as const, mime: "image/png" as const, data: "cG5n" }
                }),
                receipt: {
                  version: 1 as const,
                  requestID: "desktop_watch_test",
                  startedAt: 1,
                  finishedAt: 2,
                  effect: "observe" as const,
                  outcome: "confirmed" as const,
                },
              }
            }
            return {
              operation:
                input.operation === "type"
                  ? ("type" as const)
                  : input.operation === "key"
                    ? ("key" as const)
                    : input.operation === "scroll"
                      ? ("scroll" as const)
                      : input.operation === "move"
                        ? ("move" as const)
                        : input.operation === "drag"
                          ? ("drag" as const)
                          : ("click" as const),
              receipt: {
                version: 1 as const,
                requestID: "desktop_click_test",
                startedAt: 1,
                finishedAt: 2,
                effect: "interact" as const,
                outcome: "confirmed" as const,
                target: { surface: "desktop" as const, windowID: "window_seen" },
                observationID: ObservationID.make("observation_seen"),
              },
            }
          }),
        list: () => Effect.succeed([]),
        cancelSession: () => Effect.void,
        reply: () => Effect.void,
        reject: () => Effect.void,
      }
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_desktop_tools"),
        messageID: MessageID.make("msg_desktop_tools"),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (input) => Effect.sync(() => asks.push(input)),
      }
      const effects = () => calls.filter((input) => input.operation !== "authorize")
      const result = yield* DesktopClickTool.pipe(
        Effect.provideService(Desktop.Service, host),
        Effect.flatMap(Tool.init),
        Effect.flatMap((tool) =>
          tool.execute(
            {
              window_id: "window_seen",
              observation_id: ObservationID.make("observation_seen"),
              x: 0.25,
              y: 0.75,
              action: "double_click",
              button: "right",
              sensitive_category: "ordinary",
            },
            ctx,
          ),
        ),
      )
      expect(asks).toEqual([
        expect.objectContaining({ permission: "desktop_click", patterns: ["window_seen:0.2500,0.7500"], always: [] }),
      ])
      expect(effects()).toEqual([
        {
          operation: "click",
          sessionID: ctx.sessionID,
          windowID: "window_seen",
          observationID: ObservationID.make("observation_seen"),
          sensitive: false,
          action: "double_click",
          button: "right",
          x: 0.25,
          y: 0.75,
        },
      ])
      expect(result.title).toBe("Double-clicked desktop")

      const moved = yield* DesktopMoveTool.pipe(
        Effect.provideService(Desktop.Service, host),
        Effect.flatMap(Tool.init),
        Effect.flatMap((tool) =>
          tool.execute(
            {
              window_id: "window_seen",
              observation_id: ObservationID.make("observation_moved"),
              x: 0.5,
              y: 0.125,
              sensitive_category: "ordinary",
            },
            ctx,
          ),
        ),
      )
      expect(asks[1]).toEqual(
        expect.objectContaining({ permission: "desktop_move", patterns: ["window_seen:0.5000,0.1250"], always: [] }),
      )
      expect(effects()[1]).toEqual({
        operation: "move",
        sessionID: ctx.sessionID,
        windowID: "window_seen",
        observationID: ObservationID.make("observation_moved"),
        sensitive: false,
        x: 0.5,
        y: 0.125,
      })
      expect(moved.title).toBe("Moved desktop pointer")

      const typed = yield* DesktopTypeTool.pipe(
        Effect.provideService(Desktop.Service, host),
        Effect.flatMap(Tool.init),
        Effect.flatMap((tool) =>
          tool.execute(
            {
              window_id: "window_seen",
              observation_id: ObservationID.make("observation_typed"),
              text: "Exact text",
              sensitive_category: "ordinary",
            },
            ctx,
          ),
        ),
      )
      expect(asks[2]).toEqual(
        expect.objectContaining({
          permission: "desktop_type",
          patterns: ["window_seen"],
          always: [],
          metadata: { length: 10 },
        }),
      )
      expect(effects()[2]).toEqual({
        operation: "type",
        sessionID: ctx.sessionID,
        windowID: "window_seen",
        observationID: ObservationID.make("observation_typed"),
        sensitive: false,
        text: "Exact text",
      })
      expect(typed.title).toBe("Typed into desktop")

      const keyed = yield* DesktopKeyTool.pipe(
        Effect.provideService(Desktop.Service, host),
        Effect.flatMap(Tool.init),
        Effect.flatMap((tool) =>
          tool.execute(
            {
              window_id: "window_seen",
              observation_id: ObservationID.make("observation_keyed"),
              key: "Enter",
              modifiers: ["control", "control", "shift"],
              sensitive_category: "ordinary",
            },
            ctx,
          ),
        ),
      )
      expect(asks[3]).toEqual(
        expect.objectContaining({
          permission: "desktop_key",
          patterns: ["window_seen:control+shift+Enter"],
          always: [],
        }),
      )
      expect(effects()[3]).toEqual({
        operation: "key",
        sessionID: ctx.sessionID,
        windowID: "window_seen",
        observationID: ObservationID.make("observation_keyed"),
        sensitive: false,
        key: "Enter",
        modifiers: ["control", "shift"],
      })
      expect(keyed.title).toBe("Pressed control+shift+Enter")
      expect(Schema.is(Key)("F12")).toBe(true)
      expect(Schema.is(Key)("F13")).toBe(false)
      expect(Schema.is(Key)(";")).toBe(false)

      const scrolled = yield* DesktopScrollTool.pipe(
        Effect.provideService(Desktop.Service, host),
        Effect.flatMap(Tool.init),
        Effect.flatMap((tool) =>
          tool.execute(
            {
              window_id: "window_seen",
              observation_id: ObservationID.make("observation_scrolled"),
              delta_x: 120,
              delta_y: -240,
              sensitive_category: "ordinary",
            },
            ctx,
          ),
        ),
      )
      expect(asks[4]).toEqual(
        expect.objectContaining({
          permission: "desktop_scroll",
          patterns: ["window_seen:120,-240"],
          always: [],
        }),
      )
      expect(effects()[4]).toEqual({
        operation: "scroll",
        sessionID: ctx.sessionID,
        windowID: "window_seen",
        observationID: ObservationID.make("observation_scrolled"),
        sensitive: false,
        deltaX: 120,
        deltaY: -240,
      })
      expect(scrolled.title).toBe("Scrolled desktop")
      const base = {
        id: "desktop_scroll_schema",
        sessionID: ctx.sessionID,
        operation: "scroll" as const,
        windowID: "window_seen",
        observationID: ObservationID.make("observation_scroll_schema"),
        sensitive: false,
      }
      expect(Schema.is(ScrollRequest)({ ...base, deltaX: 0, deltaY: 0 })).toBe(false)
      expect(Schema.is(ScrollRequest)({ ...base, deltaX: 0, deltaY: 1_201 })).toBe(false)
      expect(Schema.is(ScrollRequest)({ ...base, sensitive: undefined, deltaX: 0, deltaY: 120 })).toBe(false)
      expect(Schema.is(ScrollRequest)({ ...base, sensitive: true, deltaX: 0, deltaY: 120 })).toBe(false)
      expect(Schema.is(ScrollRequest)({ ...base, deltaX: 0, deltaY: 120 })).toBe(true)

      const watched = yield* DesktopWatchTool.pipe(
        Effect.provideService(Desktop.Service, host),
        Effect.flatMap(Tool.init),
        Effect.flatMap((tool) => tool.execute({ frames: 3, interval_ms: 500 }, ctx)),
      )
      expect(asks[5]).toEqual(
        expect.objectContaining({
          permission: "desktop_watch",
          patterns: ["foreground-window:3x500ms"],
          always: [],
        }),
      )
      expect(effects()[5]).toEqual({ operation: "watch", sessionID: ctx.sessionID, frameCount: 3, intervalMs: 500 })
      expect(watched.title).toBe("Observed 3 desktop frames (2 images)")
      expect(watched.attachments).toHaveLength(2)
      expect(watched.attachments?.map((item) => item.filename)).toEqual(["desktop-frame-1.png", "desktop-frame-3.png"])
      expect(JSON.parse(watched.output).frames[1]).toMatchObject({
        change: "unchanged",
        baseObservationID: "observation_watch_0",
      })
      const watch = { id: "watch_schema", sessionID: ctx.sessionID, operation: "watch" as const }
      expect(Schema.is(WatchRequest)({ ...watch, frameCount: 1, intervalMs: 500 })).toBe(false)
      expect(Schema.is(WatchRequest)({ ...watch, frameCount: 3, intervalMs: 49 })).toBe(false)
      expect(Schema.is(WatchRequest)({ ...watch, frameCount: 16, intervalMs: 50 })).toBe(true)
      expect(Schema.is(WatchRequest)({ ...watch, frameCount: 16, intervalMs: 1_000 })).toBe(false)
      expect(Schema.is(WatchRequest)({ ...watch, frameCount: 8, intervalMs: 1_000 })).toBe(false)
      expect(Schema.is(WatchRequest)({ ...watch, frameCount: 17, intervalMs: 50 })).toBe(false)
      expect(Schema.is(WatchRequest)({ ...watch, frameCount: 4, intervalMs: 1_001 })).toBe(false)

      const dragged = yield* DesktopDragTool.pipe(
        Effect.provideService(Desktop.Service, host),
        Effect.flatMap(Tool.init),
        Effect.flatMap((tool) =>
          tool.execute(
            {
              window_id: "window_seen",
              observation_id: ObservationID.make("observation_dragged"),
              start_x: 0.125,
              start_y: 0.25,
              end_x: 0.875,
              end_y: 0.75,
              button: "right",
              sensitive_category: "ordinary",
            },
            ctx,
          ),
        ),
      )
      expect(asks[6]).toEqual(
        expect.objectContaining({
          permission: "desktop_drag",
          patterns: ["window_seen:right:0.1250,0.2500->0.8750,0.7500"],
          always: [],
        }),
      )
      expect(effects()[6]).toEqual({
        operation: "drag",
        sessionID: ctx.sessionID,
        windowID: "window_seen",
        observationID: ObservationID.make("observation_dragged"),
        sensitive: false,
        startX: 0.125,
        startY: 0.25,
        endX: 0.875,
        endY: 0.75,
        button: "right",
      })
      expect(dragged.title).toBe("Dragged on desktop")
      const drag = {
        id: "drag_schema",
        sessionID: ctx.sessionID,
        operation: "drag" as const,
        windowID: "window_seen",
        observationID: ObservationID.make("observation_drag_schema"),
        sensitive: false,
        startX: 0.5,
        startY: 0.5,
        endX: 0.5,
        endY: 0.5,
        button: "left" as const,
      }
      expect(Schema.is(DragRequest)(drag)).toBe(false)
      expect(Schema.is(DragRequest)({ ...drag, endX: 1.1 })).toBe(false)
      expect(Schema.is(DragRequest)({ ...drag, endX: 0.75 })).toBe(true)
      expect(calls.filter((input) => input.operation === "authorize").map((input) => input.action)).toEqual([
        "pointer",
        "pointer",
        "keyboard",
        "keyboard",
        "scroll",
        "observe",
        "pointer",
      ])
      expect(calls.filter((input) => input.operation === "authorize").every((input) => input.sensitive === false)).toBe(
        true,
      )
    }),
  { git: true },
)
