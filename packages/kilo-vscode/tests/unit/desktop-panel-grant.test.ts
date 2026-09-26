import { describe, expect, it, mock } from "bun:test"
import type { DesktopRequest } from "@kilocode/sdk/v2/client"
import {
  ComputerUseLeaseStore,
  type GrantInput,
  type LeaseStorage,
  type SensitivePolicy,
} from "../../src/services/computer-use/lease-store"

let receive: ((message: unknown) => void) | undefined
let opened = 0
const posts: unknown[] = []

mock.module("vscode", () => ({
  ViewColumn: { Beside: 2 },
  window: {
    createWebviewPanel: () => {
      opened++
      return {
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
      }
    },
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
  opened = 0
  posts.length = 0
  const grants: GrantInput[] = []
  const saved: SensitivePolicy[] = []
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
    savedPolicy: () => undefined,
    savePolicy: async (value: SensitivePolicy) => {
      saved.push(value)
    },
  }
  const panel = new DesktopPanel(session as never, lease as never, async () => true)
  const grant = (rememberPolicy = false, sensitive: SensitivePolicy = policy("ask")) =>
    receive?.({
      type: "grant",
      level: "observe",
      duration: "session",
      applications: "current",
      actions: ["observe"],
      sensitive,
      rememberPolicy,
      cooperativeInput: false,
    })
  return { panel, grants, saved, grant, state }
}

const policy = (rule: SensitivePolicy[keyof SensitivePolicy]): SensitivePolicy => ({
  communications: rule,
  financial: rule,
  credentials: rule,
  software: rule,
  system: rule,
  deletion: rule,
  disclosure: rule,
  legal: rule,
  publishing: rule,
})

function active(level: "assisted" | "autonomous", rule: SensitivePolicy[keyof SensitivePolicy]) {
  receive = undefined
  opened = 0
  let writes = 0
  let pins = 0
  const storage: LeaseStorage = {
    get: () => undefined,
    update: async () => {
      writes++
    },
  }
  const lease = new ComputerUseLeaseStore(storage, () => 100)
  const session = {
    pinCurrent: async () => {
      pins++
      return undefined
    },
    onState: () => () => undefined,
    takeControl: () => undefined,
  }
  const panel = new DesktopPanel(session as never, lease, async () => true)
  const grant = () =>
    lease.grant({
      sessionID: "session_test",
      level,
      duration: "until_stopped",
      applications: "all",
      actions: ["pointer"],
      sensitive: policy(rule),
      cooperativeInput: false,
    })
  return { panel, lease, grant, writes: () => writes, pins: () => pins }
}

describe("selected desktop grant review", () => {
  it("saves reusable sensitive choices only when explicitly selected in grant review", async () => {
    const test = setup("0x111")
    const first = test.panel.authorize(request("0x111"))
    await Bun.sleep(0)
    test.grant()
    await first
    expect(test.saved).toHaveLength(0)
    const second = test.panel.authorize(request("0x111"))
    await Bun.sleep(0)
    const sensitive = policy("deny")
    sensitive.communications = "allow_always"
    test.grant(true, sensitive)
    await second
    expect(test.saved).toEqual([sensitive])
  })

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

  it("rejects a forged durable grant for an exact window before saving it", async () => {
    const test = setup("0x111")
    const done = test.panel.authorize(request("0x111"))
    await Bun.sleep(0)
    receive?.({
      type: "grant",
      level: "autonomous",
      duration: "until_stopped",
      applications: "current",
      actions: ["observe", "pointer"],
      sensitive: policy("ask"),
      rememberPolicy: false,
      cooperativeInput: false,
    })
    await Bun.sleep(0)
    expect(test.grants).toHaveLength(0)
    expect(posts).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "This exact window can only be authorized for the current task.",
      }),
    )
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

describe("sensitive action review with an existing lease", () => {
  for (const level of ["assisted", "autonomous"] as const) {
    it(`leaves the ${level} lease intact for one action-specific prompt`, async () => {
      const test = active(level, "ask")
      const grant = await test.grant()
      const writes = test.writes()
      const result = await test.panel.authorize({
        ...request("window_test"),
        action: "pointer",
        sensitive: "communications",
      })
      const repeated = await test.panel.authorize({
        ...request("window_test"),
        action: "pointer",
        sensitive: "communications",
      })
      expect(result.decision).toBe("ask")
      expect(repeated.decision).toBe("ask")
      expect(test.lease.current()?.id).toBe(grant.id)
      expect(test.lease.current()?.sensitive).toEqual(grant.sensitive)
      expect(test.writes()).toBe(writes)
      expect(test.pins()).toBe(0)
      expect(opened).toBe(0)
      expect(receive).toBeUndefined()
    })
  }

  it("denies sensitive work without opening another grant review", async () => {
    const test = active("autonomous", "deny")
    const grant = await test.grant()
    const writes = test.writes()
    const result = await test.panel.authorize({
      ...request("window_test"),
      action: "pointer",
      sensitive: "communications",
    })
    expect(result.decision).toBe("deny")
    expect(test.lease.current()?.id).toBe(grant.id)
    expect(test.writes()).toBe(writes)
    expect(opened).toBe(0)
  })

  it("still opens the initial grant review when no lease exists", async () => {
    const test = active("autonomous", "ask")
    const done = test.panel.authorize({ ...request("window_test"), action: "pointer", sensitive: "communications" })
    await Bun.sleep(0)
    expect(opened).toBe(1)
    expect(test.lease.current()).toBeUndefined()
    receive?.({ type: "decline" })
    expect((await done).decision).toBe("deny")
    expect(test.writes()).toBe(0)
  })

  it("keeps out-of-scope work on the grant review path", async () => {
    const test = active("autonomous", "ask")
    const grant = await test.grant()
    const done = test.panel.authorize({
      ...request("window_test"),
      action: "keyboard",
      sensitive: "communications",
    })
    await Bun.sleep(0)
    expect(opened).toBe(1)
    expect(test.lease.current()?.id).toBe(grant.id)
    receive?.({ type: "decline" })
    expect((await done).decision).toBe("deny")
  })
})
