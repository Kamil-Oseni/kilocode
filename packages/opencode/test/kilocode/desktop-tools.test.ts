// raya_change - model-facing native desktop tool tests
import { expect } from "bun:test"
import { ObservationID } from "@/kilocode/computer-use/protocol"
import { Key } from "@/kilocode/desktop/protocol"
import { Desktop } from "@/kilocode/desktop/service"
import { DesktopClickTool, DesktopKeyTool, DesktopTypeTool } from "@/kilocode/tool/desktop-host"
import { MessageID, SessionID } from "@/session/schema"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Agent } from "@/agent/agent"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(Agent.node), AppNodeBuilder.build(Truncate.node)))

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
            return {
              operation:
                input.operation === "type"
                  ? ("type" as const)
                  : input.operation === "key"
                    ? ("key" as const)
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
            },
            ctx,
          ),
        ),
      )
      expect(asks).toEqual([
        expect.objectContaining({ permission: "desktop_click", patterns: ["window_seen:0.2500,0.7500"], always: [] }),
      ])
      expect(calls).toEqual([
        {
          operation: "click",
          sessionID: ctx.sessionID,
          windowID: "window_seen",
          observationID: ObservationID.make("observation_seen"),
          action: "double_click",
          button: "right",
          x: 0.25,
          y: 0.75,
        },
      ])
      expect(result.title).toBe("Double-clicked desktop")

      const typed = yield* DesktopTypeTool.pipe(
        Effect.provideService(Desktop.Service, host),
        Effect.flatMap(Tool.init),
        Effect.flatMap((tool) =>
          tool.execute(
            {
              window_id: "window_seen",
              observation_id: ObservationID.make("observation_typed"),
              text: "Exact text",
            },
            ctx,
          ),
        ),
      )
      expect(asks[1]).toEqual(
        expect.objectContaining({
          permission: "desktop_type",
          patterns: ["window_seen"],
          always: [],
          metadata: { length: 10 },
        }),
      )
      expect(calls[1]).toEqual({
        operation: "type",
        sessionID: ctx.sessionID,
        windowID: "window_seen",
        observationID: ObservationID.make("observation_typed"),
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
            },
            ctx,
          ),
        ),
      )
      expect(asks[2]).toEqual(
        expect.objectContaining({
          permission: "desktop_key",
          patterns: ["window_seen:control+shift+Enter"],
          always: [],
        }),
      )
      expect(calls[2]).toEqual({
        operation: "key",
        sessionID: ctx.sessionID,
        windowID: "window_seen",
        observationID: ObservationID.make("observation_keyed"),
        key: "Enter",
        modifiers: ["control", "shift"],
      })
      expect(keyed.title).toBe("Pressed control+shift+Enter")
      expect(Schema.is(Key)("F12")).toBe(true)
      expect(Schema.is(Key)("F13")).toBe(false)
      expect(Schema.is(Key)(";")).toBe(false)
    }),
  { git: true },
)
