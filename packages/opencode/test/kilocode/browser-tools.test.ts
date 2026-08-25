// raya_change - Milestone F model-facing browser tool tests
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import * as KiloAgent from "@/kilocode/agent"
import type { Result } from "@/kilocode/browser/protocol"
import { Browser } from "@/kilocode/browser/service"
import { Permission } from "@/permission"
import {
  BrowserClickTool,
  BrowserEvaluateTool,
  BrowserNavigateTool,
  BrowserScreenshotTool,
  BrowserScrollTool,
  BrowserSelectTool,
  BrowserSnapshotTool,
  BrowserTypeTool,
} from "@/kilocode/tool/browser-host"
import { MessageID, SessionID } from "@/session/schema"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const calls: Browser.Input[] = []
function result(input: Browser.Input): Result {
  if (input.operation === "snapshot")
    return { operation: "snapshot", url: "https://example.com", snapshot: 'button "Continue" [ref=e1]' }
  if (input.operation === "screenshot")
    return { operation: "screenshot", url: "https://example.com", mime: "image/png", data: "cG5n" }
  if (input.operation === "evaluate")
    return { operation: "evaluate", url: "https://example.com", output: '{"ok":true}' }
  return { operation: input.operation, url: input.operation === "navigate" ? input.url : "https://example.com" }
}

const host: Browser.Interface = {
  request: (input) =>
    Effect.sync(() => {
      calls.push(input)
      return result(input)
    }),
  list: () => Effect.succeed([]),
  cancelSession: () => Effect.void,
  reply: () => Effect.void,
  reject: () => Effect.void,
}
const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(Agent.node), AppNodeBuilder.build(Truncate.node)))

function context(asks: Parameters<Tool.Context["ask"]>[0][]): Tool.Context {
  return {
    sessionID: SessionID.make("ses_browser_tools"),
    messageID: MessageID.make("msg_browser_tools"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) => Effect.sync(() => asks.push(input)),
  }
}

test("auto-approves every native browser action in VS Code", () => {
  const previous = process.env.KILO_CLIENT
  process.env.KILO_CLIENT = "vscode"
  try {
    const rules = KiloAgent.prepare({}).defaultsPatch
    for (const permission of [
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_select",
      "browser_scroll",
      "browser_screenshot",
      "browser_evaluate",
    ]) {
      expect(Permission.evaluate(permission, "*", rules).action).toBe("allow")
    }
  } finally {
    if (previous === undefined) delete process.env.KILO_CLIENT
    else process.env.KILO_CLIENT = previous
  }
})

describe("browser host tools", () => {
  it.instance(
    "forwards all operations with dedicated permissions and image output",
    () =>
      Effect.gen(function* () {
        calls.length = 0
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const ctx = context(asks)
        const navigate = yield* BrowserNavigateTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        const snapshot = yield* BrowserSnapshotTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        const click = yield* BrowserClickTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        const type = yield* BrowserTypeTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        const select = yield* BrowserSelectTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        const scroll = yield* BrowserScrollTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        const screenshot = yield* BrowserScreenshotTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        const evaluate = yield* BrowserEvaluateTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )

        yield* navigate.execute({ url: "https://example.com" }, ctx)
        const tree = yield* snapshot.execute({}, ctx)
        yield* click.execute({ selector: "e1" }, ctx)
        yield* type.execute({ selector: "#name", text: "Raya", submit: true }, ctx)
        yield* select.execute({ selector: "#role", values: ["admin"] }, ctx)
        yield* scroll.execute({ delta_x: 4, delta_y: 500, selector: "#main" }, ctx)
        const image = yield* screenshot.execute({ full_page: true }, ctx)
        const value = yield* evaluate.execute({ expression: "() => ({ ok: true })" }, ctx)

        expect(calls.map((item) => item.operation)).toEqual([
          "navigate",
          "snapshot",
          "click",
          "type",
          "select",
          "scroll",
          "screenshot",
          "evaluate",
        ])
        expect(calls[3]).toMatchObject({ text: "Raya", submit: true })
        expect(calls[5]).toMatchObject({ deltaX: 4, deltaY: 500 })
        expect(asks.map((item) => item.permission)).toEqual([
          "browser_navigate",
          "browser_snapshot",
          "browser_click",
          "browser_type",
          "browser_select",
          "browser_scroll",
          "browser_screenshot",
          "browser_evaluate",
        ])
        expect(tree.output).toContain("Continue")
        expect(value.output).toBe('{"ok":true}')
        expect(image.attachments?.[0]).toMatchObject({
          mime: "image/png",
          url: "data:image/png;base64,cG5n",
        })
      }),
    { git: true },
  )
})
