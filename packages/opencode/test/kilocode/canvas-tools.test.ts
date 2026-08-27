// raya_change - Milestone E model-facing canvas tool tests
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import * as KiloAgent from "@/kilocode/agent"
import { Canvas } from "@/kilocode/canvas/service"
import { CreateCanvasTool, UpdateCanvasTool } from "@/kilocode/tool/canvas-host"
import { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const calls: Canvas.Input[] = []
const host: Canvas.Interface = {
  request: (input) =>
    Effect.sync(() => {
      calls.push(input)
      return {
        operation: input.operation,
        name: input.name,
        path: `.raya/canvases/${input.name}.canvas.tsx`,
        status:
          input.operation === "update" && input.source?.includes("broken") ? ("error" as const) : ("ready" as const),
        version: calls.length,
        error:
          input.operation === "update" && input.source?.includes("broken") ? "2:8: Expected identifier" : undefined,
      }
    }),
  list: () => Effect.succeed([]),
  cancelSession: () => Effect.void,
  reply: () => Effect.void,
  reject: () => Effect.void,
}
const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(Agent.node), AppNodeBuilder.build(Truncate.node)))

function context(asks: Parameters<Tool.Context["ask"]>[0][]): Tool.Context {
  return {
    sessionID: SessionID.make("ses_canvas_tools"),
    messageID: MessageID.make("msg_canvas_tools"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) => Effect.sync(() => asks.push(input)),
  }
}

test("auto-approves native canvas actions in VS Code", () => {
  const previous = process.env.KILO_CLIENT
  process.env.KILO_CLIENT = "vscode"
  try {
    const rules = KiloAgent.prepare({}).defaultsPatch
    expect(Permission.evaluate("create_canvas", "*", rules).action).toBe("allow")
    expect(Permission.evaluate("update_canvas", "*", rules).action).toBe("allow")
  } finally {
    if (previous === undefined) delete process.env.KILO_CLIENT
    else process.env.KILO_CLIENT = previous
  }
})

describe("canvas host tools", () => {
  it.instance("forwards source and data and returns repairable errors", () =>
    Effect.gen(function* () {
      calls.length = 0
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const ctx = context(asks)
      const create = yield* CreateCanvasTool.pipe(
        Effect.provideService(Canvas.Service, host),
        Effect.flatMap(Tool.init),
      )
      const update = yield* UpdateCanvasTool.pipe(
        Effect.provideService(Canvas.Service, host),
        Effect.flatMap(Tool.init),
      )

      const first = yield* create.execute(
        {
          name: "sales-report",
          source: "export default function Report({ data }) { return <div>{data.total}</div> }",
          data: { total: 42 },
        },
        ctx,
      )
      const broken = yield* update.execute(
        {
          name: "sales-report",
          source: "broken",
        },
        ctx,
      )

      expect(calls).toEqual([
        {
          operation: "create",
          sessionID: ctx.sessionID,
          name: "sales-report",
          source: "export default function Report({ data }) { return <div>{data.total}</div> }",
          data: { total: 42 },
        },
        {
          operation: "update",
          sessionID: ctx.sessionID,
          name: "sales-report",
          source: "broken",
          data: undefined,
        },
      ])
      expect(first.metadata.status).toBe("ready")
      expect(broken.metadata.status).toBe("error")
      expect(broken.output).toContain("Expected identifier")
      expect(asks.map((ask) => ask.permission)).toEqual(["create_canvas", "update_canvas"])
      expect(create.description).toContain("live React canvas")
      expect(update.description).toContain("refreshes automatically")
    }),
  )
})
