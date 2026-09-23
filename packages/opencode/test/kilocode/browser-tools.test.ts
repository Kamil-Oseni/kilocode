// raya_change - Milestone F model-facing browser tool tests
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import * as KiloAgent from "@/kilocode/agent"
import { Selector, SmokeStep, type Result } from "@/kilocode/browser/protocol"
import { ObservationID } from "@/kilocode/computer-use/protocol"
import { Browser, HostError } from "@/kilocode/browser/service"
import { Permission } from "@/permission"
import {
  BrowserDialogTool,
  BrowserDownloadTool,
  BrowserFramesTool,
  BrowserTabsTool,
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
  if (input.operation === "authorize")
    return { operation: "authorize", decision: "ask", reason: "No active Computer Use grant" }
  const profile = {
    profileID: "a".repeat(64),
    directory: "workspace",
    status: "ready" as const,
    authentication: { source: "live" as const, profileID: "a".repeat(64), login: "unverified" as const },
  }
  if (input.operation === "profile") return { operation: "profile", profile }
  if (input.operation === "auth") return { operation: "auth", profile, captures: [] }
  if (input.operation === "upload") return { operation: "upload", uploads: [] }
  if (input.operation === "download") {
    if (input.action !== "inspect") return { operation: "download", transfers: [] }
    return {
      operation: "download",
      artifact: "C:\\browser-artifacts\\transfer_seen\\artifact",
      transfers: [
        {
          version: 1,
          id: input.transferID,
          tabID: "tab_seen",
          profile: "workspace",
          status: "completed",
          filename: "report.csv",
          url: "https://example.com/report.csv",
          createdAt: 1,
          updatedAt: 2,
          bytes: 128,
          sha256: "a".repeat(64),
        },
      ],
    }
  }
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
    return {
      operation: "auth_capture",
      name: input.name,
      cookies: 1,
      origins: 1,
      capture: {
        id: "00000000-0000-4000-8000-000000000001",
        profileID: "a".repeat(64),
        directory: "workspace",
        name: input.name,
        createdAt: 1,
        expiresAt: 2,
        origins: ["https://example.com"],
        domains: ["example.com"],
        cookies: 1,
        bytes: 10,
        sha256: "0".repeat(64),
        status: "available",
      },
    }
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
      authentication: { source: "live", profileID: "a".repeat(64), login: "unverified" },
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
            observation_id: ObservationID.make("obs_upload"),
            selector: "input[type=file]",
            destination: "https://example.test/form",
            paths: [source],
            sensitive_category: "ordinary",
          },
          ctx,
        )
        expect(asks.map((ask) => ask.permission)).toEqual(["browser_upload", "read"])
        const request = calls.find((call) => call.operation === "upload")!
        expect(request.operation).toBe("upload")
        if (request.operation !== "upload" || request.action !== "start") throw new Error("Missing upload request")
        expect(request.files[0]).toMatchObject({ name: "upload.txt", bytes: 17 })
        expect(request.observationID).toBe(ObservationID.make("obs_upload"))
        expect(JSON.stringify(request)).not.toContain(source)
        const stage = new UploadStage()
        const owner = { directory: instance.directory, sessionID: ctx.sessionID, uploadID: request.uploadID }
        const chunk = yield* Effect.promise(() => stage.chunk(owner, request.files[0].id, 0))
        expect(Buffer.from(chunk.data, "base64").toString()).toBe("authorized upload")
        yield* Effect.promise(() => stage.release(owner, request.files[0].id))
        yield* tool.execute({ action: "inspect", upload_id: request.uploadID }, ctx)
        expect(calls.find((call) => call.operation === "upload" && call.action === "inspect")).toMatchObject({
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
          {
            action: "start",
            tab_id: "tab_seen",
            observation_id: ObservationID.make("obs_download"),
            selector: { kind: "role", role: "button", name: "Export" },
            sensitive_category: "ordinary",
          },
          ctx,
        )
        const inspected = yield* tool.execute({ action: "inspect", transfer_id: "transfer_seen" }, ctx)
        yield* tool.execute({ action: "cancel", transfer_id: "transfer_seen" }, ctx)
        const effects = calls.filter((call) => call.operation !== "authorize")
        expect(effects).toHaveLength(3)
        expect(effects[0]).toMatchObject({
          operation: "download",
          action: "start",
          sessionID: ctx.sessionID,
          tabID: "tab_seen",
          observationID: "obs_download",
        })
        expect(effects[1]).toMatchObject({
          operation: "download",
          action: "inspect",
          sessionID: ctx.sessionID,
          transferID: "transfer_seen",
        })
        expect(effects[2]).toMatchObject({
          operation: "download",
          action: "cancel",
          sessionID: ctx.sessionID,
          transferID: "transfer_seen",
        })
        expect(inspected.metadata.rayaBrowserDownload).toEqual({
          version: 1,
          transferID: "transfer_seen",
          artifact: "C:\\browser-artifacts\\transfer_seen\\artifact",
          filename: "report.csv",
          url: "https://example.com/report.csv",
          bytes: 128,
          sha256: "a".repeat(64),
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
        const failed = yield* click
          .execute(
            {
              tab_id: "tab_seen",
              observation_id: ObservationID.make("obs_dialog"),
              selector: "#save",
              sensitive_category: "ordinary",
            },
            context([]),
          )
          .pipe(Effect.exit)
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
          {
            action: "accept",
            tab_id: "tab_seen",
            dialog_id: "dialog_seen",
            text: "Ada",
            sensitive_category: "ordinary",
          },
          context([]),
        )
        yield* dialog.execute({ action: "list", tab_id: "tab_seen", operation_id: "op_seen" }, context([]))
        const effects = calls.filter((call) => call.operation !== "authorize")
        expect(effects[0]).toMatchObject({
          operation: "dialog",
          action: "accept",
          tabID: "tab_seen",
          dialogID: "dialog_seen",
          text: "Ada",
        })
        expect(effects[1]).toMatchObject({ operation: "dialog", action: "list", operationID: "op_seen" })
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
        yield* click.execute(
          {
            tab_id: "tab_seen",
            frame_id: "frame_child",
            observation_id: ObservationID.make("obs_frame"),
            selector: "button",
            sensitive_category: "ordinary",
          },
          ctx,
        )
        const effects = calls.filter((call) => call.operation !== "authorize")
        expect(effects[1]).toMatchObject({ operation: "frames", parentID: "frame_parent", selector: "#form" })
        expect(effects[2]).toMatchObject({ operation: "click", tabID: "tab_seen", frameID: "frame_child" })
      }),
    60_000,
  )

  it.instance(
    "forwards stable tab commands and refuses missing mutation grounding",
    () =>
      Effect.gen(function* () {
        calls.length = 0
        const ctx = context([])
        const tabs = yield* BrowserTabsTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        yield* tabs.execute({ action: "list" }, ctx)
        yield* tabs.execute({ action: "open", url: "https://example.com", sensitive_category: "ordinary" }, ctx)
        yield* tabs.execute({ action: "select", tab_id: "tab_seen", sensitive_category: "ordinary" }, ctx)
        yield* tabs.execute({ action: "close", tab_id: "tab_seen", sensitive_category: "ordinary" }, ctx)
        const effects = calls.filter((call) => call.operation !== "authorize")
        expect(effects.map((call) => (call.operation === "tabs" ? call.action : call.operation))).toEqual([
          "list",
          "open",
          "select",
          "close",
        ])
        expect(effects[2]).toMatchObject({ tabID: "tab_seen" })
        const click = yield* BrowserClickTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )
        const failed = yield* click
          .execute(
            { observation_id: ObservationID.make("obs_missing_tab"), selector: "#save" } as {
              selector: string
              tab_id: string
              observation_id: typeof ObservationID.Type
              sensitive_category: "ordinary"
            },
            ctx,
          )
          .pipe(Effect.exit)
        expect(failed._tag).toBe("Failure")
        const ungrounded = yield* click
          .execute(
            { tab_id: "tab_seen", selector: "#save", sensitive_category: "ordinary" } as {
              selector: string
              tab_id: string
              observation_id: typeof ObservationID.Type
              sensitive_category: "ordinary"
            },
            ctx,
          )
          .pipe(Effect.exit)
        expect(ungrounded._tag).toBe("Failure")
        expect(calls.filter((call) => call.operation !== "authorize")).toHaveLength(4)
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
        yield* tool.execute(
          {
            tab_id: "tab_test",
            observation_id: ObservationID.make("obs_semantic"),
            selector,
            sensitive_category: "ordinary",
          },
          context(asks),
        )
        expect(calls.find((call) => call.operation === "click")).toMatchObject({ operation: "click", selector })
        expect(asks[0].patterns).toEqual([JSON.stringify(selector)])
        expect(asks[0].always).toEqual([JSON.stringify(selector)])
        const count = calls.length
        const failed = yield* tool
          .execute(
            {
              tab_id: "tab_test",
              observation_id: ObservationID.make("obs_invalid"),
              selector: { kind: "role", role: "button" } as typeof Selector.Type,
              sensitive_category: "ordinary",
            },
            context(asks),
          )
          .pipe(Effect.exit)
        expect(failed._tag).toBe("Failure")
        expect(calls).toHaveLength(count)
      }),
    60_000,
  )

  it.instance(
    "skips the legacy prompt when the shared host grant authorizes browser control",
    () =>
      Effect.gen(function* () {
        const inputs: Browser.Input[] = []
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const granted: Browser.Interface = {
          ...host,
          request: (input) =>
            Effect.sync(() => {
              inputs.push(input)
              if (input.operation === "authorize")
                return {
                  operation: "authorize" as const,
                  decision: "allow" as const,
                  reason: "Authorized by shared grant",
                }
              return result(input)
            }),
        }
        const tool = yield* BrowserClickTool.pipe(
          Effect.provideService(Browser.Service, granted),
          Effect.flatMap(Tool.init),
        )
        yield* tool.execute(
          {
            tab_id: "tab_test",
            observation_id: ObservationID.make("obs_granted"),
            selector: "#send",
            sensitive_category: "communications",
          },
          context(asks),
        )
        expect(asks).toEqual([])
        expect(inputs[0]).toMatchObject({
          operation: "authorize",
          surface: "browser",
          action: "browser",
          windowID: "tab_test",
          sensitive: "communications",
        })
        expect(inputs[1]).toMatchObject({ operation: "click", selector: "#send" })
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
        const smoke = yield* BrowserSmokeTestTool.pipe(
          Effect.provideService(Browser.Service, host),
          Effect.flatMap(Tool.init),
        )

        yield* navigate.execute({ url: "https://example.com", sensitive_category: "ordinary" }, ctx)
        const tree = yield* snapshot.execute({}, ctx)
        yield* click.execute(
          {
            tab_id: "tab_test",
            observation_id: ObservationID.make("obs_seen"),
            selector: "e1",
            sensitive_category: "ordinary",
          },
          ctx,
        )
        yield* type.execute(
          {
            tab_id: "tab_test",
            observation_id: ObservationID.make("obs_type"),
            selector: "#name",
            text: "Raya",
            submit: true,
            sensitive_category: "ordinary",
          },
          ctx,
        )
        yield* select.execute(
          {
            tab_id: "tab_test",
            observation_id: ObservationID.make("obs_select"),
            selector: "#role",
            values: ["admin"],
            sensitive_category: "ordinary",
          },
          ctx,
        )
        yield* scroll.execute(
          {
            tab_id: "tab_test",
            observation_id: ObservationID.make("obs_scroll"),
            delta_x: 4,
            delta_y: 500,
            selector: "#main",
            sensitive_category: "ordinary",
          },
          ctx,
        )
        const image = yield* screenshot.execute({ full_page: true }, ctx)
        const value = yield* evaluate.execute(
          {
            tab_id: "tab_test",
            observation_id: ObservationID.make("obs_evaluate"),
            expression: "() => ({ ok: true })",
            sensitive_category: "ordinary",
          },
          ctx,
        )
        const report = yield* smoke.execute(
          {
            tab_id: "tab_test",
            sensitive_category: "ordinary",
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

        const effects = calls.filter((item) => item.operation !== "authorize")
        const authorizations = calls.filter((item) => item.operation === "authorize")
        expect(authorizations).toHaveLength(9)
        expect(authorizations.every((item) => item.sensitive === false)).toBe(true)
        expect(effects.map((item) => item.operation)).toEqual([
          "navigate",
          "snapshot",
          "click",
          "type",
          "select",
          "scroll",
          "screenshot",
          "evaluate",
          "smoke",
        ])
        expect(effects[3]).toMatchObject({ text: "Raya", submit: true })
        expect(effects[2]).toMatchObject({ observationID: "obs_seen" })
        expect(effects[5]).toMatchObject({ deltaX: 4, deltaY: 500 })
        expect(asks.map((item) => item.permission)).toEqual([
          "browser_navigate",
          "browser_snapshot",
          "browser_click",
          "browser_type",
          "browser_select",
          "browser_scroll",
          "browser_screenshot",
          "browser_evaluate",
          "browser_smoke_test",
        ])
        expect(tree.output).toContain("Continue")
        expect(tree.output).not.toContain("profileID")
        expect(report.output).not.toContain("authentication")
        expect(report.output).not.toContain("authState")
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
