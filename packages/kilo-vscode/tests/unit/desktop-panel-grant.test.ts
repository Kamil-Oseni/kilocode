import { describe, expect, it, mock } from "bun:test"
import type { DesktopRequest } from "@kilocode/sdk/v2/client"
import type { GrantInput } from "../../src/services/computer-use/lease-store"

let receive: ((message: unknown) => void) | undefined
const posts: unknown[] = []

mock.module("vscode", () => ({
  ViewColumn: { Beside: 2 },
  window: {
    createWebviewPanel: () => ({
      webview: {
        html: "",
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          receive = listener
        },
        postMessage: async (message: unknown) => {
          posts.push(message)
          return true
        },
      },
      reveal: () => undefined,
      onDidDispose: () => undefined,
      dispose: () => undefined,
    }),
    showErrorMessage: async () => undefined,
  },
}))

const { DesktopPanel } = await import("../../src/services/computer-use/desktop-panel")

const request = (windowID: string) =>
  ({
    id: "grant_request",
    sessionID: "session_test",
    operation: "authorize",
    surface: "desktop",
    action: "observe",
    windowID,
    sensitive: false,
  }) satisfies Extract<DesktopRequest, { operation: "authorize" }>

function setup(foreground: string) {
  receive = undefined
  posts.length = 0
  const grants: GrantInput[] = []
  const state = { identity: "A".repeat(64) }
  const target = { windowID: foreground, title: "Editor", identity: state.identity }
  const session = {
    pinCurrent: async (windowID: string) => {
      if (windowID !== foreground) throw new Error("Selected desktop window is no longer foreground")
      return target
    },
    verify: async (windowID: string, identity: string) => {
      if (windowID !== foreground || identity !== state.identity) throw new Error("Selected window changed")
    },
    onState: () => () => undefined,
    takeControl: () => undefined,
    resume: () => undefined,
    observe: async () => undefined,
  }
  const lease = {
    review: () => ({ operation: "authorize", decision: "ask", reason: "Review grant" }),
    grant: async (input: GrantInput) => {
      grants.push(input)
      return { state: "active" }
    },
    authorize: () => ({ operation: "authorize", decision: "allow", reason: "Granted", grantID: "grant_test" }),
    onChange: () => () => undefined,
    current: () => undefined,
  }
  const panel = new DesktopPanel(session as never, lease as never, async () => true)
  const grant = () =>
    receive?.({
      type: "grant",
      level: "observe",
      duration: "session",
      applications: "current",
      actions: ["observe"],
      sensitive: {},
      cooperativeInput: false,
    })
  return { panel, grants, grant, state }
}

describe("selected desktop grant review", () => {
  it("refuses an agent-named window that was not foreground before the panel opened", async () => {
    const test = setup("0x111")
    const done = test.panel.authorize(request("0x222"))
    await Bun.sleep(0)
    test.grant()
    await Bun.sleep(0)
    expect(test.grants).toHaveLength(0)
    expect(posts).toContainEqual(expect.objectContaining({ type: "error" }))
    receive?.({ type: "decline" })
    expect((await done).decision).toBe("deny")
  })

  it("rejects a replaced window before saving the selected grant", async () => {
    const test = setup("0x111")
    const done = test.panel.authorize(request("0x111"))
    await Bun.sleep(0)
    test.state.identity = "B".repeat(64)
    test.grant()
    await Bun.sleep(0)
    expect(test.grants).toHaveLength(0)
    expect(posts).toContainEqual(expect.objectContaining({ type: "error" }))
    receive?.({ type: "decline" })
    expect((await done).decision).toBe("deny")
  })

  it("shows and grants only the pinned foreground window", async () => {
    const test = setup("0x111")
    const done = test.panel.authorize(request("0x111"))
    await Bun.sleep(0)
    expect(posts).toContainEqual(
      expect.objectContaining({
        type: "lease",
        pending: expect.objectContaining({ currentApplicationAvailable: true, currentApplicationTitle: "Editor" }),
      }),
    )
    test.grant()
    expect((await done).decision).toBe("allow")
    expect(test.grants).toEqual([
      expect.objectContaining({ applications: "current", windowID: "0x111", identity: "A".repeat(64) }),
    ])
  })
})
