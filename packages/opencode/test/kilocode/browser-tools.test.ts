// raya_change - Milestone F model-facing browser tool tests
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import * as KiloAgent from "@/kilocode/agent"
import { Selector, SmokeStep, type Result } from "@/kilocode/browser/protocol"
import { Browser, HostError } from "@/kilocode/browser/service"
import { Permission } from "@/permission"
import {
  BrowserDialogTool,
  BrowserDownloadTool,
  BrowserFramesTool,
  BrowserTabsTool,
  BrowserAuthCaptureTool,
  BrowserClickTool,
  BrowserEvaluateTool,
  BrowserNavigateTool,
  BrowserScreenshotTool,
  BrowserScrollTool,
  BrowserSelectTool,
  BrowserSnapshotTool,
  BrowserSmokeTestTool,
  BrowserTypeTool,
} from "@/kilocode/tool/browser-host"
import { MessageID, SessionID } from "@/session/schema"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { BrowserUploadTool } from "@/kilocode/tool/browser-upload"
import { UploadStage } from "@/kilocode/browser/upload-stage"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const calls: Browser.Input[] = []
function result(input: Browser.Input): Result {
  if (input.operation === "upload") return { operation: "upload", uploads: [] }
  if (input.operation === "download") return { operation: "download", transfers: [] }
  if (input.operation === "dialog") return { operation: "dialog", tabID: input.tabID, dialogs: [], operations: [] }
  if (input.operation === "frames") return { operation: "frames", tabID: input.tabID, frames: [] }
  if (input.operation === "tabs") return { operation: "tabs", tabs: [] }
  if (input.operation === "snapshot")
    return { operation: "snapshot", url: "https://example.com", snapshot: 'button "Continue" [ref=e1]' }
  if (input.operation === "screenshot")
    return { operation: "screenshot", url: "https://example.com", mime: "image/png", data: "cG5n" }
  if (input.operation === "evaluate")
    return { operation: "evaluate", url: "https://example.com", output: '{"ok":true}' }
  if (input.operation === "auth_capture")
    return { operation: "auth_capture", name: input.name, path: "auth.json", cookies: 1, origins: 1 }
  if (input.operation === "smoke")
    return {
      operation: "smoke",
      runID: "run_green",
      name: input.name,
      mode: input.mode,
      passed: true,
      startedAt: 1,
      finishedAt: 2,
      artifact: "report.json",
      authState: "auth.json",
      steps: [
        {
          id: "dashboard",
          title: "Dashboard",
          passed: true,
          screenshot: "dashboard.png",
          assertions: [{ kind: "visible", passed: true, expected: "visible", actual: "visible" }],
        },
      ],
      network: [{ url: "/health", status: 200 }],
      console: [],
    }
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
const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Truncate.node),
    AppNodeBuilder.build(FSUtil.node),
  ),
)

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
      "browser_dialog",
      "browser_download",
      "browser_upload",
      "browser_frames",
      "browser_tabs",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_select",
      "browser_scroll",
      "browser_screenshot",
      "browser_evaluate",
      "browser_auth_capture",
      "browser_smoke_test",
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
    "upload tool reads an authorized source and forwards only owned staged references",
    () =>
      Effect.gen(function* () {
        calls.length = 0
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const ctx = context(asks)
        const instance = yield* InstanceState.context
        const source = path.join(instance.directory, "upload.txt")
        yield* Effect.promise(() => Bun.write(source, "authorized upload"))
        const tool = yield* BrowserUploadTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        yield* tool.execute(
          {
            action: "start",
            tab_id: "tab_seen",
            selector: "input[type=file]",
            destination: "https://example.test/form",
            paths: [source],
          },
          ctx,
        )
        expect(asks.map((ask) => ask.permission)).toEqual(["browser_upload", "read"])
        const request = calls[0]
        expect(request.operation).toBe("upload")
        if (request.operation !== "upload" || request.action !== "start") throw new Error("Missing upload request")
        expect(request.files[0]).toMatchObject({ name: "upload.txt", bytes: 17 })
        expect(JSON.stringify(request)).not.toContain(source)
        const stage = new UploadStage()
        const owner = { directory: instance.directory, sessionID: ctx.sessionID, uploadID: request.uploadID }
        const chunk = yield* Effect.promise(() => stage.chunk(owner, request.files[0].id, 0))
        expect(Buffer.from(chunk.data, "base64").toString()).toBe("authorized upload")
        yield* Effect.promise(() => stage.release(owner, request.files[0].id))
        yield* tool.execute({ action: "inspect", upload_id: request.uploadID }, ctx)
        expect(calls[1]).toMatchObject({
          operation: "upload",
          action: "inspect",
          uploadID: request.uploadID,
          sessionID: ctx.sessionID,
        })
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "download inspection stays task-bound and never repeats an initiating click",
    () =>
      Effect.gen(function* () {
        calls.length = 0
        const ctx = context([])
        const tool = yield* BrowserDownloadTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        yield* tool.execute(
          { action: "start", tab_id: "tab_seen", selector: { kind: "role", role: "button", name: "Export" } },
          ctx,
        )
        yield* tool.execute({ action: "inspect", transfer_id: "transfer_seen" }, ctx)
        yield* tool.execute({ action: "cancel", transfer_id: "transfer_seen" }, ctx)
        expect(calls).toHaveLength(3)
        expect(calls[0]).toMatchObject({
          operation: "download",
          action: "start",
          sessionID: ctx.sessionID,
          tabID: "tab_seen",
        })
        expect(calls[1]).toMatchObject({
          operation: "download",
          action: "inspect",
          sessionID: ctx.sessionID,
          transferID: "transfer_seen",
        })
        expect(calls[2]).toMatchObject({
          operation: "download",
          action: "cancel",
          sessionID: ctx.sessionID,
          transferID: "transfer_seen",
        })
      }),
    60000,
  )
  test("semantic target schemas preserve exact fields and reject incomplete targets", () => {
    const decode = Schema.decodeUnknownSync(Selector)
    for (const target of [
      "#legacy",
      { kind: "role", role: "button", name: "Save", scope: "#form" },
      { kind: "label", text: "Name" },
      { kind: "testid", value: "result" },
    ] as const)
      expect(decode(target)).toEqual(target)
    for (const target of [
      { kind: "role", role: "button" },
      { kind: "label", text: "" },
      { kind: "testid", value: 1 },
      { kind: "unknown", value: "x" },
      { kind: "label", text: "Name", scope: "" },
    ])
      expect(() => decode(target)).toThrow()
    const step = {
      id: "save",
      title: "Save",
      action: { kind: "click", selector: { kind: "role", role: "button", name: "Save" } },
      assertions: [{ kind: "visible", selector: { kind: "testid", value: "saved" } }],
    } as const
    expect(Schema.decodeUnknownSync(SmokeStep)(step)).toEqual(step)
  })

  it.instance(
    "preserves pending dialog failures and forwards observed responses without replay",
    () =>
      Effect.gen(function* () {
        let count = 0
        const waiting: Browser.Interface = {
          ...host,
          request: () => {
            count++
            return Effect.fail(
              new HostError({
                code: "dialog_pending",
                detail: "Browser operation remains pending and must not be retried. operation_id=op_observed",
              }),
            )
          },
        }
        const click = yield* BrowserClickTool.pipe(
          Effect.provideService(Browser.Service, waiting),
          Effect.flatMap(Tool.init),
        )
        const failed = yield* click.execute({ tab_id: "tab_seen", selector: "#save" }, context([])).pipe(Effect.exit)
        expect(failed._tag).toBe("Failure")
        expect(JSON.stringify(failed)).toContain("dialog_pending")
        expect(JSON.stringify(failed)).toContain("must not be retried")
        expect(count).toBe(1)
        calls.length = 0
        const dialog = yield* BrowserDialogTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        yield* dialog.execute(
          { action: "accept", tab_id: "tab_seen", dialog_id: "dialog_seen", text: "Ada" },
          context([]),
        )
        yield* dialog.execute({ action: "list", tab_id: "tab_seen", operation_id: "op_seen" }, context([]))
        expect(calls[0]).toMatchObject({
          operation: "dialog",
          action: "accept",
          tabID: "tab_seen",
          dialogID: "dialog_seen",
          text: "Ada",
        })
        expect(calls[1]).toMatchObject({ operation: "dialog", action: "list", operationID: "op_seen" })
      }),
    60_000,
  )

  it.instance(
    "forwards frame document identity without changing tab targeting",
    () =>
      Effect.gen(function* () {
        calls.length = 0
        const ctx = context([])
        const frames = yield* BrowserFramesTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        yield* frames.execute({ action: "list", tab_id: "tab_seen" }, ctx)
        yield* frames.execute(
          { action: "resolve", tab_id: "tab_seen", parent_frame_id: "frame_parent", selector: "#form" },
          ctx,
        )
        const click = yield* BrowserClickTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        yield* click.execute({ tab_id: "tab_seen", frame_id: "frame_child", selector: "button" }, ctx)
        expect(calls[1]).toMatchObject({ operation: "frames", parentID: "frame_parent", selector: "#form" })
        expect(calls[2]).toMatchObject({ operation: "click", tabID: "tab_seen", frameID: "frame_child" })
      }),
    60_000,
  )

  it.instance(
    "forwards stable tab commands and refuses missing mutation identity",
    () =>
      Effect.gen(function* () {
        calls.length = 0
        const ctx = context([])
        const tabs = yield* BrowserTabsTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        yield* tabs.execute({ action: "list" }, ctx)
        yield* tabs.execute({ action: "open", url: "https://example.com" }, ctx)
        yield* tabs.execute({ action: "select", tab_id: "tab_seen" }, ctx)
        yield* tabs.execute({ action: "close", tab_id: "tab_seen" }, ctx)
        expect(calls.map((call) => (call.operation === "tabs" ? call.action : call.operation))).toEqual([
          "list",
          "open",
          "select",
          "close",
        ])
        expect(calls[2]).toMatchObject({ tabID: "tab_seen" })
        const click = yield* BrowserClickTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        const failed = yield* click
          .execute({ selector: "#save" } as { selector: string; tab_id: string }, ctx)
          .pipe(Effect.exit)
        expect(failed._tag).toBe("Failure")
        expect(calls).toHaveLength(4)
      }),
    60_000,
  )

  it.instance(
    "semantic targets reach the host with stable permission patterns",
    () =>
      Effect.gen(function* () {
        calls.length = 0
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const tool = yield* BrowserClickTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        const selector = { kind: "role" as const, role: "button", name: "Save", scope: "#form" }
        yield* tool.execute({ tab_id: "tab_test", selector }, context(asks))
        expect(calls[0]).toMatchObject({ operation: "click", selector })
        expect(asks[0].patterns).toEqual([JSON.stringify(selector)])
        expect(asks[0].always).toEqual([JSON.stringify(selector)])
        const count = calls.length
        const failed = yield* tool
          .execute(
            { tab_id: "tab_test", selector: { kind: "role", role: "button" } as typeof Selector.Type },
            context(asks),
          )
          .pipe(Effect.exit)
        expect(failed._tag).toBe("Failure")
        expect(calls).toHaveLength(count)
      }),
    60_000,
  )

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
        const auth = yield* BrowserAuthCaptureTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        const smoke = yield* BrowserSmokeTestTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )

        yield* navigate.execute({ url: "https://example.com" }, ctx)
        const tree = yield* snapshot.execute({}, ctx)
        yield* click.execute({ tab_id: "tab_test", selector: "e1" }, ctx)
        yield* type.execute({ tab_id: "tab_test", selector: "#name", text: "Raya", submit: true }, ctx)
        yield* select.execute({ tab_id: "tab_test", selector: "#role", values: ["admin"] }, ctx)
        yield* scroll.execute({ tab_id: "tab_test", delta_x: 4, delta_y: 500, selector: "#main" }, ctx)
        const image = yield* screenshot.execute({ full_page: true }, ctx)
        const value = yield* evaluate.execute({ tab_id: "tab_test", expression: "() => ({ ok: true })" }, ctx)
        yield* auth.execute({ tab_id: "tab_test", name: "sample-app" }, ctx)
        const report = yield* smoke.execute(
          {
            tab_id: "tab_test",
            name: "sample-app",
            mode: "scripted",
            steps: [
              {
                id: "dashboard",
                title: "Dashboard",
                action: { kind: "navigate", url: "https://example.com/app" },
                assertions: [
                  { kind: "visible", selector: "#welcome" },
                  { kind: "network", url: "/health", status: 200 },
                ],
              },
            ],
          },
          ctx,
        )

        expect(calls.map((item) => item.operation)).toEqual([
          "navigate",
          "snapshot",
          "click",
          "type",
          "select",
          "scroll",
          "screenshot",
          "evaluate",
          "auth_capture",
          "smoke",
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
          "browser_auth_capture",
          "browser_smoke_test",
        ])
        expect(tree.output).toContain("Continue")
        expect(value.output).toContain('{"ok":true}')
        expect(navigate.description).toContain("browse") // raya_change - plain-English Milestone F activation
        expect(snapshot.description).toContain("inspect a website")
        expect(smoke.description).toContain("plain-English")
        expect(report.metadata).toMatchObject({
          passed: true,
          runID: "run_green",
          artifact: "report.json",
          evidence: "raya-smoke-v1",
        })
        expect(image.attachments?.[0]).toMatchObject({
          mime: "image/png",
          url: "data:image/png;base64,cG5n",
        })
      }),
    { git: true },
  )
})
