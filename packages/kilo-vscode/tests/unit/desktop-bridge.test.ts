import { describe, expect, it } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import type { DesktopRequest, KiloClient } from "@kilocode/sdk/v2/client"
import {
  DesktopBridge,
  type DesktopConnection,
  type DesktopReceiptStore,
} from "../../src/services/computer-use/desktop-bridge"
import { DesktopSession, type DesktopDriver } from "../../src/services/computer-use/desktop-session"
import { ComputerUseLeaseStore, type SensitivePolicy } from "../../src/services/computer-use/lease-store"
import type { ConnectionState } from "../../src/services/cli-backend/connection-service"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"

const request: DesktopRequest = {
  id: "desktop_1",
  sessionID: "ses_desktop",
  operation: "observe",
  authorization: { kind: "prompt" },
}

function setup(
  input: {
    store?: DesktopReceiptStore
    pending?: DesktopRequest[]
    fail?: boolean
    rejectFail?: boolean
    actionError?: Error
    actionHold?: Promise<void>
    hold?: Promise<void>
    decision?: "allow" | "ask" | "deny"
    dispatchDecision?: "allow" | "ask" | "deny"
    dispatch?: () => "allow" | "ask" | "deny"
    dispatchGrant?: string | null
    validate?: (
      request: Extract<DesktopRequest, { operation: "authorize" }>,
    ) => ReturnType<ComputerUseLeaseStore["authorize"]>
    pixels?: string[]
    frameWindow?: string
    frameWindows?: string[]
    frameLocations?: string[]
    currentWindow?: string
    listed?: string[]
    listedIdentity?: string | (() => string)
    onCapture?: () => void
  } = {},
) {
  const replies: unknown[] = []
  const rejects: unknown[] = []
  const actions: unknown[] = []
  const checks: unknown[] = []
  const focused: string[] = []
  const events = new Set<(event: SSEPayload, directory?: string) => void>()
  const states = new Set<(state: ConnectionState, error?: Error) => void>()
  let captured = 0
  const driver: DesktopDriver = {
    observe: async () => {
      input.onCapture?.()
      return {
        windowID: input.frameWindows?.[captured] ?? input.frameWindow ?? "window_1",
        location: input.frameLocations?.[captured] ?? "process|title|bounds",
        width: 20,
        height: 10,
        mime: "image/png",
        data: input.pixels?.[captured++] ?? "cG5n",
        semantics: {
          source: "windows_ui_automation",
          status: "available",
          viewport: { x: 0, y: 0, width: 20, height: 10 },
          controls: [
            {
              controlID: "42.7",
              role: "Button",
              name: "Save",
              x: 4,
              y: 5,
              width: 10,
              height: 6,
              enabled: true,
              focused: false,
              actions: ["invoke"],
            },
          ],
          truncated: false,
        },
        timing: { acquisitionMs: 5, preparationMs: 7, semanticsMs: 3, totalMs: 20 },
      }
    },
    windows: async () =>
      (input.listed ?? ["window_2"]).map((windowID) => ({
        windowID,
        identity:
          typeof input.listedIdentity === "function"
            ? input.listedIdentity()
            : (input.listedIdentity ?? "process_test"),
        location: "pid:7;class:Browser;title:Browser",
        title: "Browser",
        processID: 7,
        x: 40,
        y: 20,
        width: 1000,
        height: 700,
        minimized: false,
        foreground: windowID === (input.currentWindow ?? "window_2"),
      })),
    current: async () => ({ windowID: input.currentWindow ?? "window_1", location: "process|title|bounds" }),
    focus: async (target) => {
      focused.push(target.windowID)
    },
    perform: async (action) => {
      actions.push(action)
      if (input.actionHold) await input.actionHold
      if (input.actionError) throw input.actionError
    },
  }
  const client = {
    kilocode: {
      desktop: {
        list: async () => ({ data: input.pending ?? [] }),
        reply: async (value: unknown) => {
          replies.push(value)
          const operation = (value as { result?: { operation?: string } }).result?.operation
          if (input.fail && operation !== "observe" && operation !== "watch") return { error: { message: "offline" } }
          return { data: true }
        },
        reject: async (value: unknown) => {
          rejects.push(value)
          if (input.rejectFail) return { error: { message: "offline" } }
          return { data: true }
        },
      },
    },
  } as unknown as KiloClient
  const connection: DesktopConnection = {
    onEvent: (listener) => {
      events.add(listener)
      return () => events.delete(listener)
    },
    onStateChange: (listener) => {
      states.add(listener)
      return () => states.delete(listener)
    },
    getKnownDirectories: () => ["C:\\workspace"],
    getClient: () => client,
  }
  const session = new DesktopSession(driver)
  let observed = 0
  const validate = input.validate
  const bridge = new DesktopBridge(
    connection,
    session,
    async (request, signal) => {
      if (input.hold) await input.hold
      if (signal.aborted) throw new Error("Desktop viewing was stopped")
      const count = request.operation === "watch" ? request.frameCount : 1
      const frames = []
      for (const _index of Array.from({ length: count }, (_, index) => index)) {
        observed += 1
        frames.push(await session.observe())
      }
      return frames
    },
    input.store,
    async () => ({
      operation: "authorize",
      decision: input.decision ?? "ask",
      reason: input.decision === "allow" ? "Authorized by active grant" : "No active grant",
      ...(input.decision === "allow" ? { grantID: "grant_test" } : {}),
    }),
    validate
      ? (request) => {
          checks.push(request)
          return validate(request)
        }
      : input.dispatchDecision || input.dispatch
        ? (request) => {
            checks.push(request)
            const decision = input.dispatch?.() ?? input.dispatchDecision!
            return {
              operation: "authorize",
              decision,
              reason: decision === "allow" ? "Authorized by active grant" : "Grant stopped",
              ...(decision === "allow" || (decision === "ask" && "delegation" in request && request.delegation)
                ? { grantID: input.dispatchGrant === undefined ? "grant_test" : (input.dispatchGrant ?? undefined) }
                : {}),
            }
          }
        : undefined,
  )
  return { bridge, events, states, replies, rejects, actions, checks, focused, observed: () => observed }
}

function memory(seed?: unknown) {
  let value: unknown = seed
  return {
    get: <T>(_key: string) => value as T | undefined,
    update: async (_key: string, next: unknown) => {
      value = structuredClone(next)
    },
    read: () => value,
  } satisfies DesktopReceiptStore & { read(): unknown }
}

describe("desktop observation bridge", () => {
  it("distinguishes an absent durable journal without treating it as an empty receipt set", () => {
    const test = setup({ store: memory() })
    expect(test.bridge.journalState()).toBe("absent")
    expect(test.bridge.journalSummary()).toBeNull()
    test.bridge.dispose()
  })

  async function selected() {
    const store = new ComputerUseLeaseStore(
      { get: <T>() => undefined as T | undefined, update: async () => {} },
      () => 100,
    )
    const sensitive = Object.fromEntries(
      [
        "communications",
        "financial",
        "credentials",
        "software",
        "system",
        "deletion",
        "disclosure",
        "legal",
        "publishing",
      ].map((category) => [category, "ask"]),
    ) as SensitivePolicy
    const lease = await store.grant({
      sessionID: "ses_parent",
      level: "autonomous",
      duration: "session",
      applications: "current",
      windowID: "window_2",
      identity: "process_test",
      actions: ["observe", "pointer", "window"],
      sensitive,
      cooperativeInput: false,
    })
    return { store, lease }
  }

  async function multi() {
    const store = new ComputerUseLeaseStore(
      { get: <T>() => undefined as T | undefined, update: async () => {} },
      () => 100,
    )
    const sensitive = Object.fromEntries(
      [
        "communications",
        "financial",
        "credentials",
        "software",
        "system",
        "deletion",
        "disclosure",
        "legal",
        "publishing",
      ].map((category) => [category, "ask"]),
    ) as SensitivePolicy
    const lease = await store.grant({
      sessionID: "ses_parent",
      level: "autonomous",
      duration: "session",
      applications: "selected",
      windows: [
        { windowID: "window_1", identity: "identity_one" },
        { windowID: "window_2", identity: "identity_two" },
      ],
      actions: ["observe"],
      sensitive,
      cooperativeInput: false,
    })
    return { store, lease }
  }

  it("rejects a delegated target-only sibling observation before capture", async () => {
    const grant = await multi()
    const test = setup({ frameWindow: "window_1", validate: (request) => grant.store.authorize(request) })
    const delegation = {
      parentSessionID: "ses_parent",
      childSessionID: "ses_child",
      grantID: grant.lease.id,
      windowID: "window_2",
      identity: "identity_two",
    }
    const observe: DesktopRequest = {
      ...request,
      id: "delegated_sibling_target",
      sessionID: "ses_child",
      target: { version: 1, windowID: "window_1" },
      authorization: { kind: "grant", grantID: grant.lease.id, delegation },
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: observe } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.observed()).toBe(0)
    expect(test.replies).toEqual([])
    expect(test.rejects).toContainEqual(expect.objectContaining({ requestID: observe.id }))
    test.bridge.dispose()
  })

  it("refuses targetless and forged requests for a multi-window grant before capture", async () => {
    const grant = await multi()
    const test = setup({
      listed: ["window_1", "window_2"],
      listedIdentity: "identity_two",
      frameWindow: "window_2",
      validate: (request) => grant.store.authorize(request),
    })
    const base: DesktopRequest = {
      id: "multi_missing",
      sessionID: "ses_parent",
      operation: "observe",
      authorization: { kind: "grant", grantID: grant.lease.id },
    }
    const requests: DesktopRequest[] = [
      base,
      { id: "multi_list_missing", sessionID: "ses_parent", operation: "windows", authorization: base.authorization },
      {
        id: "multi_watch_missing",
        sessionID: "ses_parent",
        operation: "watch",
        authorization: base.authorization,
        frameCount: 2,
        intervalMs: 50,
      },
      { ...base, id: "multi_forged", target: { version: 1, windowID: "window_other" } },
      { ...base, id: "multi_wrong", target: { version: 1, windowID: "window_1" } },
    ]
    for (const item of requests) {
      for (const listener of test.events)
        listener({ type: "kilocode.desktop.requested", properties: item } as SSEPayload, "C:\\workspace")
      await Bun.sleep(20)
    }
    expect(test.observed()).toBe(0)
    expect(test.replies).toEqual([])
    expect(test.rejects).toHaveLength(5)
    test.bridge.dispose()
  })

  it("returns only the exact selected window and verifies identity after capture", async () => {
    const grant = await multi()
    let identity = "identity_two"
    const test = setup({
      listed: ["window_2", "window_other"],
      listedIdentity: () => identity,
      frameWindow: "window_2",
      validate: (request) => grant.store.authorize(request),
      onCapture: () => {
        identity = "replacement"
      },
    })
    const auth = { kind: "grant" as const, grantID: grant.lease.id }
    const target = { version: 1 as const, windowID: "window_2" }
    const list: DesktopRequest = {
      id: "multi_list",
      sessionID: "ses_parent",
      operation: "windows",
      authorization: auth,
      target,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: list } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.replies).toContainEqual(
      expect.objectContaining({
        result: expect.objectContaining({ windows: [expect.objectContaining({ windowID: "window_2" })] }),
      }),
    )
    const observe: DesktopRequest = {
      id: "multi_changed",
      sessionID: "ses_parent",
      operation: "observe",
      authorization: auth,
      target,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: observe } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.observed()).toBe(1)
    expect(test.replies).toHaveLength(1)
    expect(test.rejects).toContainEqual(expect.objectContaining({ requestID: observe.id }))
    test.bridge.dispose()
  })

  it("captures a selected target only while it is foreground, including bounded watch", async () => {
    const grant = await multi()
    const target = { version: 1 as const, windowID: "window_2" }
    const auth = { kind: "grant" as const, grantID: grant.lease.id }
    const selected = setup({
      listed: ["window_2"],
      listedIdentity: "identity_two",
      frameWindow: "window_2",
      validate: (request) => grant.store.authorize(request),
    })
    const watch: DesktopRequest = {
      id: "multi_watch",
      sessionID: "ses_parent",
      operation: "watch",
      authorization: auth,
      target,
      frameCount: 2,
      intervalMs: 50,
    }
    for (const listener of selected.events)
      listener({ type: "kilocode.desktop.requested", properties: watch } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(selected.observed()).toBe(2)
    expect(selected.replies).toContainEqual(
      expect.objectContaining({ result: expect.objectContaining({ operation: "watch" }) }),
    )
    selected.bridge.dispose()

    const background = setup({
      listed: ["window_2"],
      listedIdentity: "identity_two",
      currentWindow: "window_1",
      frameWindow: "window_2",
      validate: (request) => grant.store.authorize(request),
    })
    const observe: DesktopRequest = {
      id: "multi_background",
      sessionID: "ses_parent",
      operation: "observe",
      authorization: auth,
      target,
    }
    for (const listener of background.events)
      listener({ type: "kilocode.desktop.requested", properties: observe } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(background.observed()).toBe(0)
    expect(background.replies).toEqual([])
    expect(background.rejects).toContainEqual(expect.objectContaining({ requestID: observe.id }))
    background.bridge.dispose()
  })

  it("refuses a reused parent window handle before frame delivery and input", async () => {
    const grant = await selected()
    let identity = "process_test"
    const test = setup({
      frameWindow: "window_2",
      currentWindow: "window_2",
      listed: ["window_2"],
      listedIdentity: () => identity,
      validate: (request) => grant.store.authorize(request),
    })
    const observe: DesktopRequest = {
      ...request,
      id: "parent_selected_observe",
      sessionID: "ses_parent",
      authorization: { kind: "grant", grantID: grant.lease.id },
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: observe } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const first = test.replies[0] as { result: { observation: { id: string } } }
    identity = "replacement_process"
    const replaced: DesktopRequest = { ...observe, id: "parent_selected_reused_handle" }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: replaced } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.replies).toHaveLength(1)
    expect(test.rejects).toContainEqual(expect.objectContaining({ requestID: replaced.id }))
    const click: DesktopRequest = {
      id: "parent_selected_reused_click",
      sessionID: "ses_parent",
      operation: "click",
      windowID: "window_2",
      observationID: first.result.observation.id,
      sensitive: false,
      authorization: { kind: "grant", grantID: grant.lease.id },
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.5,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([])
    expect(test.rejects).toContainEqual(expect.objectContaining({ requestID: click.id }))
    test.bridge.dispose()
  })

  it("withholds a selected-app frame when the actual foreground target changes", async () => {
    const grant = await selected()
    const test = setup({ frameWindow: "window_1", validate: (request) => grant.store.authorize(request) })
    const delegation = {
      parentSessionID: "ses_parent",
      childSessionID: "ses_child",
      grantID: grant.lease.id,
      windowID: "window_2",
      identity: "process_test",
    }
    const observe: DesktopRequest = {
      ...request,
      id: "selected_wrong_frame",
      sessionID: "ses_child",
      authorization: { kind: "grant", grantID: grant.lease.id, delegation },
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: observe } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.replies).toEqual([])
    expect(test.rejects).toContainEqual(
      expect.objectContaining({
        requestID: observe.id,
        error: expect.objectContaining({ message: expect.stringContaining("selected desktop window changed") }),
      }),
    )
    expect(test.checks).toContainEqual(expect.objectContaining({ windowID: "window_2", delegation }))
    test.bridge.dispose()
  })

  it("reveals only the selected window and refuses another target before native dispatch", async () => {
    const grant = await selected()
    const test = setup({
      frameWindow: "window_2",
      listed: ["window_1", "window_2"],
      validate: (request) => grant.store.authorize(request),
    })
    const delegation = {
      parentSessionID: "ses_parent",
      childSessionID: "ses_child",
      grantID: grant.lease.id,
      windowID: "window_2",
      identity: "process_test",
    }
    const windows: DesktopRequest = {
      id: "selected_windows",
      sessionID: "ses_child",
      operation: "windows",
      authorization: { kind: "grant", grantID: grant.lease.id, delegation },
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: windows } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const listed = test.replies[0] as { result: { windows: { windowID: string }[]; observation: { id: string } } }
    expect(listed.result.windows.map((item) => item.windowID)).toEqual(["window_2"])
    const focus: DesktopRequest = {
      id: "selected_wrong_focus",
      sessionID: "ses_child",
      operation: "focus",
      windowID: "window_1",
      observationID: listed.result.observation.id,
      sensitive: false,
      authorization: { kind: "grant", grantID: grant.lease.id, delegation },
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: focus } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.focused).toEqual([])
    expect(test.rejects).toContainEqual(expect.objectContaining({ requestID: focus.id }))
    const observe: DesktopRequest = {
      ...request,
      id: "selected_observe",
      sessionID: "ses_child",
      authorization: { kind: "grant", grantID: grant.lease.id, delegation },
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: observe } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[1] as { result: { observation: { id: string } } }
    const click: DesktopRequest = {
      id: "selected_wrong_click",
      sessionID: "ses_child",
      operation: "click",
      windowID: "window_1",
      observationID: observed.result.observation.id,
      sensitive: false,
      authorization: { kind: "grant", grantID: grant.lease.id, delegation },
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([])
    expect(test.rejects).toContainEqual(expect.objectContaining({ requestID: click.id }))
    const prompt: DesktopRequest = {
      ...click,
      id: "selected_wrong_prompt",
      authorization: { kind: "prompt", delegation },
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: prompt } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([])
    expect(test.rejects).toContainEqual(expect.objectContaining({ requestID: prompt.id }))
    test.bridge.dispose()
  })

  it("withholds a changed-window sequence frame after input and records an unknown outcome", async () => {
    const grant = await selected()
    const test = setup({
      frameWindows: ["window_2", "window_1"],
      currentWindow: "window_2",
      pixels: ["selected", "other-window"],
      validate: (request) => grant.store.authorize(request),
    })
    const delegation = {
      parentSessionID: "ses_parent",
      childSessionID: "ses_child",
      grantID: grant.lease.id,
      windowID: "window_2",
      identity: "process_test",
    }
    const observe: DesktopRequest = {
      ...request,
      id: "selected_sequence_observe",
      sessionID: "ses_child",
      authorization: { kind: "grant", grantID: grant.lease.id, delegation },
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: observe } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as { result: { observation: { id: string } } }
    const sequence: DesktopRequest = {
      id: "selected_sequence_changed",
      sessionID: "ses_child",
      operation: "sequence",
      windowID: "window_2",
      observationID: observed.result.observation.id,
      maxDurationMs: 5_000,
      steps: [
        {
          action: {
            operation: "pointer",
            action: "click",
            windowID: "window_2",
            sensitive: false,
            authorization: { kind: "grant", grantID: grant.lease.id, delegation },
            x: 0.5,
            y: 0.5,
            button: "left",
          },
          preconditions: [],
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
      ],
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: sequence } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toHaveLength(1)
    expect(test.replies).toHaveLength(1)
    expect(test.rejects).toContainEqual(
      expect.objectContaining({
        requestID: sequence.id,
        error: expect.objectContaining({ receipt: expect.objectContaining({ outcome: "unknown" }) }),
      }),
    )
    test.bridge.dispose()
  })

  it("revalidates the exact child delegation on observation and native input", async () => {
    const test = setup({ dispatchDecision: "allow" })
    const delegation = { parentSessionID: "ses_parent", childSessionID: "ses_child", grantID: "grant_test" }
    const observe: DesktopRequest = {
      ...request,
      id: "child_observe",
      sessionID: "ses_child",
      authorization: { kind: "grant", grantID: "grant_test", delegation },
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: observe } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const result = test.replies[0] as { result: { observation: { id: string; target: { windowID: string } } } }
    const click: DesktopRequest = {
      id: "child_click",
      sessionID: "ses_child",
      operation: "click",
      windowID: result.result.observation.target.windowID,
      observationID: result.result.observation.id,
      sensitive: false,
      authorization: { kind: "grant", grantID: "grant_test", delegation },
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.checks).toMatchObject([
      { sessionID: "ses_child", delegation },
      { sessionID: "ses_child", delegation },
      { sessionID: "ses_child", delegation },
      { sessionID: "ses_child", delegation },
    ])
    expect(test.actions).toHaveLength(1)
    test.bridge.dispose()
  })

  it("refuses a delegated prompt when its grant stops just before native dispatch", async () => {
    let checks = 0
    let stopped: Promise<void> | undefined
    const storage = { get: <T>() => undefined as T | undefined, update: async () => {} }
    const leaseStore = new ComputerUseLeaseStore(storage, () => 100)
    const sensitive: SensitivePolicy = {
      communications: "ask",
      financial: "ask",
      credentials: "ask",
      software: "ask",
      system: "ask",
      deletion: "ask",
      disclosure: "ask",
      legal: "ask",
      publishing: "ask",
    }
    const lease = await leaseStore.grant({
      sessionID: "ses_parent",
      level: "autonomous",
      duration: "session",
      applications: "all",
      actions: ["observe", "pointer"],
      sensitive,
      cooperativeInput: false,
    })
    const test = setup({
      validate: (request) => {
        const decision = leaseStore.authorize(request)
        if (request.action === "pointer" && ++checks === 1) stopped = leaseStore.stop()
        return decision
      },
    })
    const delegation = { parentSessionID: "ses_parent", childSessionID: "ses_child", grantID: lease.id }
    const observe: DesktopRequest = {
      ...request,
      id: "prompt_observe",
      sessionID: "ses_child",
      authorization: { kind: "prompt", delegation },
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: observe } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const result = test.replies[0] as { result: { observation: { id: string; target: { windowID: string } } } }
    const click: DesktopRequest = {
      id: "prompt_click_stopped",
      sessionID: "ses_child",
      operation: "click",
      windowID: result.result.observation.target.windowID,
      observationID: result.result.observation.id,
      sensitive: "communications",
      authorization: { kind: "prompt", delegation },
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    await stopped

    expect(checks).toBe(2)
    expect(test.checks.slice(-2)).toMatchObject([{ delegation }, { delegation }])
    expect(test.actions).toEqual([])
    expect(test.rejects).toContainEqual(
      expect.objectContaining({
        requestID: click.id,
        error: expect.objectContaining({ message: expect.stringContaining("no longer authorized") }),
      }),
    )
    test.bridge.dispose()
  })

  it("refuses a delegated prompt when revalidation no longer names the same grant", async () => {
    const test = setup({ dispatchDecision: "ask", dispatchGrant: "grant_other" })
    const delegation = { parentSessionID: "ses_parent", childSessionID: "ses_child", grantID: "grant_test" }
    const observe: DesktopRequest = {
      ...request,
      id: "prompt_changed_grant",
      sessionID: "ses_child",
      authorization: { kind: "prompt", delegation },
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: observe } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([])
    expect(test.rejects).toContainEqual(
      expect.objectContaining({
        requestID: observe.id,
        error: expect.objectContaining({ message: expect.stringContaining("outside its active grant") }),
      }),
    )
    test.bridge.dispose()
  })

  it("negotiates a grant decision without capturing or dispatching input", async () => {
    const test = setup({ decision: "allow" })
    const auth: DesktopRequest = {
      id: "desktop_authorize_1",
      sessionID: "ses_desktop",
      operation: "authorize",
      surface: "desktop",
      action: "pointer",
      windowID: "window_1",
      sensitive: false,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: auth } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)

    expect(test.observed()).toBe(0)
    expect(test.actions).toEqual([])
    expect(test.replies).toContainEqual({
      requestID: auth.id,
      directory: "C:\\workspace",
      result: {
        operation: "authorize",
        decision: "allow",
        reason: "Authorized by active grant",
        grantID: "grant_test",
      },
    })
    test.bridge.dispose()
  })

  it("lists sanitized windows and focuses one exact catalog target once", async () => {
    const test = setup()
    const windows: DesktopRequest = { id: "desktop_windows_1", sessionID: "ses_desktop", operation: "windows" }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: windows } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.replies[0]).toMatchObject({
      requestID: windows.id,
      result: {
        operation: "windows",
        windows: [expect.objectContaining({ windowID: "window_2", title: "Browser", processID: 7 })],
        receipt: { effect: "observe", outcome: "confirmed" },
      },
    })
    const listed = test.replies[0] as {
      result: { windows: Array<Record<string, unknown>>; observation: { id: string } }
    }
    expect(listed.result.windows[0]).not.toHaveProperty("location")
    const focus: DesktopRequest = {
      id: "desktop_focus_1",
      sessionID: "ses_desktop",
      operation: "focus",
      windowID: "window_2",
      observationID: listed.result.observation.id,
      sensitive: false,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: focus } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: focus } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)

    expect(test.focused).toEqual(["window_2"])
    expect(test.replies).toContainEqual(
      expect.objectContaining({
        requestID: focus.id,
        result: expect.objectContaining({
          operation: "focus",
          receipt: expect.objectContaining({ effect: "manage", outcome: "confirmed" }),
        }),
      }),
    )
    test.bridge.dispose()
  })

  it("delivers one grounded image with a request-bound receipt", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.observed()).toBe(1)
    expect(test.rejects).toEqual([])
    expect(test.replies).toHaveLength(1)
    expect(test.replies[0]).toMatchObject({
      requestID: request.id,
      directory: "C:\\workspace",
      result: {
        operation: "observe",
        width: 20,
        height: 10,
        mime: "image/png",
        data: "cG5n",
        timing: { acquisitionMs: 5, preparationMs: 7, semanticsMs: 3, totalMs: 20 },
        semantics: {
          source: "windows_ui_automation",
          status: "available",
          viewport: { x: 0, y: 0, width: 20, height: 10 },
          controls: [expect.objectContaining({ controlID: "42.7", role: "Button", name: "Save" })],
          truncated: false,
        },
        observation: { target: { surface: "desktop", windowID: "window_1", location: "process|title|bounds" } },
        receipt: { requestID: request.id, effect: "observe", outcome: "confirmed" },
      },
    })
    test.bridge.dispose()
  })

  it("does not pause desktop control for a disconnected startup state", async () => {
    const test = setup()
    for (const listener of test.states) listener("disconnected")
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.observed()).toBe(1)
    expect(test.replies).toHaveLength(1)
    expect(test.rejects).toEqual([])
    test.bridge.dispose()
  })

  it("requires explicit resume after a live backend disconnect", async () => {
    const test = setup()
    for (const listener of test.states) listener("connected")
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    for (const listener of test.states) listener("disconnected")
    for (const listener of test.states) listener("connected")
    const click: DesktopRequest = {
      id: "desktop_reconnect_1",
      sessionID: "ses_desktop",
      operation: "click",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      authorization: { kind: "grant", grantID: "grant_test" },
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([])
    expect(test.rejects).toContainEqual(
      expect.objectContaining({
        requestID: click.id,
        error: expect.objectContaining({ message: expect.stringContaining("Resume agent desktop control") }),
      }),
    )
    test.bridge.dispose()
  })

  it("aborts an active desktop capture when the live backend disconnects", async () => {
    const gate = Promise.withResolvers<void>()
    const test = setup({ hold: gate.promise })
    for (const listener of test.states) listener("connected")
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(0)
    for (const listener of test.states) listener("error")
    gate.resolve()
    await Bun.sleep(20)
    expect(test.observed()).toBe(0)
    expect(test.replies).toEqual([])
    expect(test.rejects).toEqual([])
    test.bridge.dispose()
  })

  it("cancels capture and queued input immediately when the user stops control", async () => {
    const gate = Promise.withResolvers<void>()
    const test = setup({ hold: gate.promise })
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(0)
    test.bridge.cancel("User stopped desktop control")
    gate.resolve()
    await Bun.sleep(20)

    expect(test.observed()).toBe(0)
    expect(test.actions).toEqual([])
    expect(test.replies).toEqual([])
    test.bridge.dispose()
  })

  it("redelivers its receipt without capturing the same request twice", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.observed()).toBe(1)
    expect(test.replies).toHaveLength(2)
    test.bridge.dispose()
  })

  it("retires acknowledged receipts so prolonged desktop use does not reach the journal limit", async () => {
    const test = setup()
    for (const index of Array.from({ length: 257 }, (_, value) => value)) {
      const next = { ...request, id: `desktop_long_${index}` }
      for (const listener of test.events)
        listener({ type: "kilocode.desktop.requested", properties: next } as SSEPayload, "C:\\workspace")
      await Bun.sleep(0)
    }
    expect(test.observed()).toBe(257)
    expect(test.replies).toHaveLength(257)
    expect(test.rejects).toEqual([])
    test.bridge.dispose()
  })

  it("delivers a bounded grounded frame sequence with one receipt", async () => {
    const test = setup()
    const watch: DesktopRequest = {
      id: "desktop_watch_1",
      sessionID: "ses_desktop",
      operation: "watch",
      frameCount: 3,
      intervalMs: 500,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: watch } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.observed()).toBe(3)
    expect(test.rejects).toEqual([])
    expect(test.replies[0]).toMatchObject({
      requestID: watch.id,
      result: {
        operation: "watch",
        frames: [
          {
            change: "keyframe",
            width: 20,
            height: 10,
            data: "cG5n",
            observation: { target: { surface: "desktop", windowID: "window_1" } },
          },
          {
            change: "unchanged",
            width: 20,
            height: 10,
            observation: { target: { surface: "desktop", windowID: "window_1" } },
          },
          {
            change: "unchanged",
            width: 20,
            height: 10,
            observation: { target: { surface: "desktop", windowID: "window_1" } },
          },
        ],
        receipt: { requestID: watch.id, effect: "observe", outcome: "confirmed" },
      },
    })
    const result = (test.replies[0] as { result: { frames: Array<Record<string, unknown>> } }).result
    expect(result.frames[1].baseObservationID).toBe((result.frames[0].observation as { id: string }).id)
    expect(result.frames[1]).not.toHaveProperty("data")
    expect(result.frames[2].baseObservationID).toBe(result.frames[1].baseObservationID)
    test.bridge.dispose()
  })

  it("emits a new keyframe only after the watched pixels change", async () => {
    const test = setup({ pixels: ["same", "same", "changed"] })
    const watch: DesktopRequest = {
      id: "desktop_watch_changed",
      sessionID: "ses_desktop",
      operation: "watch",
      frameCount: 3,
      intervalMs: 500,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: watch } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)

    const frames = (test.replies[0] as { result: { frames: Array<Record<string, unknown>> } }).result.frames
    expect(frames.map((frame) => frame.change)).toEqual(["keyframe", "unchanged", "keyframe"])
    expect(frames[1].baseObservationID).toBe((frames[0].observation as { id: string }).id)
    expect(frames[2]).toMatchObject({ data: "changed" })
    expect(frames[2]).not.toHaveProperty("baseObservationID")
    test.bridge.dispose()
  })

  it("starts a new keyframe when identical pixels move to another window or location", async () => {
    const test = setup({
      pixels: ["same", "same", "same", "same"],
      frameWindows: ["window_1", "window_1", "window_2", "window_2"],
      frameLocations: ["first", "first", "first", "second"],
    })
    const watch: DesktopRequest = {
      id: "desktop_watch_target_changed",
      sessionID: "ses_desktop",
      operation: "watch",
      frameCount: 4,
      intervalMs: 500,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: watch } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)

    expect(test.rejects).toEqual([])
    const frames = (test.replies[0] as { result: { frames: Array<Record<string, unknown>> } }).result.frames
    expect(frames.map((frame) => frame.change)).toEqual(["keyframe", "unchanged", "keyframe", "keyframe"])
    expect(frames[1].baseObservationID).toBe((frames[0].observation as { id: string }).id)
    expect(frames[2]).toMatchObject({ data: "same" })
    expect(frames[2]).not.toHaveProperty("baseObservationID")
    expect(frames[3]).toMatchObject({ data: "same" })
    expect(frames[3]).not.toHaveProperty("baseObservationID")
    test.bridge.dispose()
  })

  it("dispatches a click once against the exact fresh observation", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    const click: DesktopRequest = {
      id: "desktop_2",
      sessionID: "ses_desktop",
      operation: "click",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      authorization: { kind: "grant", grantID: "grant_test" },
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([expect.objectContaining({ operation: "pointer", action: "click", x: 0.5, y: 0.25 })])
    expect(test.replies[1]).toMatchObject({
      requestID: click.id,
      result: { operation: "click", receipt: { effect: "interact", outcome: "confirmed" } },
    })
    for (const listener of test.events)
      listener(
        { type: "kilocode.desktop.requested", properties: { ...click, id: "desktop_3" } } as SSEPayload,
        "C:\\workspace",
      )
    await Bun.sleep(20)
    expect(test.actions).toHaveLength(1)
    expect(test.rejects).toHaveLength(1)
    test.bridge.dispose()
  })

  it("revalidates a stopped grant locally before native dispatch", async () => {
    let decision: "allow" | "deny" = "allow"
    const test = setup({ dispatch: () => decision })
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as { result: { observation: { id: string; target: { windowID: string } } } }
    const click: DesktopRequest = {
      id: "desktop_stopped_1",
      sessionID: "ses_desktop",
      operation: "click",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      authorization: { kind: "grant", grantID: "grant_test" },
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    decision = "deny"
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)

    expect(test.actions).toEqual([])
    expect(test.rejects).toContainEqual(
      expect.objectContaining({
        requestID: click.id,
        error: expect.objectContaining({ message: expect.stringContaining("Grant stopped") }),
      }),
    )
    test.bridge.dispose()
  })

  it("refuses grant-backed input when revalidation falls back to ask", async () => {
    const test = setup({ dispatchDecision: "ask" })
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as { result: { observation: { id: string; target: { windowID: string } } } }
    const click: DesktopRequest = {
      id: "desktop_grant_expired_1",
      sessionID: "ses_desktop",
      operation: "click",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: "communications",
      authorization: { kind: "grant", grantID: "grant_test" },
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)

    expect(test.actions).toEqual([])
    expect(test.checks.at(-1)).toMatchObject({ sensitive: "communications" })
    expect(test.rejects).toContainEqual(
      expect.objectContaining({
        requestID: click.id,
        error: expect.objectContaining({ message: expect.stringContaining("grant is no longer authorized") }),
      }),
    )
    test.bridge.dispose()
  })

  it("redelivers a confirmed action after extension restart without replaying native input", async () => {
    const store = memory()
    const first = setup({ store, fail: true })
    for (const listener of first.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = first.replies[0] as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    const click: DesktopRequest = {
      id: "desktop_restart_1",
      sessionID: "ses_desktop",
      operation: "click",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    for (const listener of first.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(first.actions).toHaveLength(1)
    expect(JSON.stringify(store.read())).not.toContain("cG5n")
    expect(store.read()).toMatchObject({
      version: 2,
      items: [{ id: click.id, result: { operation: "click", receipt: { outcome: "confirmed" } } }],
    })
    first.bridge.dispose()

    const second = setup({ store, pending: [click] })
    for (const listener of second.states) listener("connected")
    await Bun.sleep(20)
    expect(second.actions).toEqual([])
    expect(second.rejects).toEqual([])
    expect(second.replies).toEqual([
      expect.objectContaining({
        requestID: click.id,
        directory: "C:\\workspace",
        result: expect.objectContaining({
          operation: "click",
          receipt: expect.objectContaining({ outcome: "confirmed" }),
        }),
      }),
    ])
    expect(store.read()).toMatchObject({ version: 2, items: [] })
    second.bridge.dispose()
  })

  it("records unknown immediately when Stop interrupts a stalled native action", async () => {
    const gate = Promise.withResolvers<void>()
    const store = memory()
    const test = setup({ store, actionHold: gate.promise, rejectFail: true })
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as { result: { observation: { id: string; target: { windowID: string } } } }
    const click: DesktopRequest = {
      id: "desktop_stopped_during_dispatch",
      sessionID: "ses_desktop",
      operation: "click",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      authorization: { kind: "prompt" },
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toHaveLength(1)
    test.bridge.cancel("User stopped desktop control")
    await Bun.sleep(20)
    expect(test.replies).toHaveLength(1)
    expect(test.rejects).toContainEqual(
      expect.objectContaining({
        requestID: click.id,
        error: expect.objectContaining({
          receipt: expect.objectContaining({ outcome: "unknown", requestID: click.id }),
        }),
      }),
    )
    expect(store.read()).toMatchObject({
      items: [{ id: click.id, failure: { receipt: { outcome: "unknown", requestID: click.id } } }],
    })
    gate.resolve()
    await Bun.sleep(20)
    expect(test.actions).toHaveLength(1)
    test.bridge.dispose()
  })

  it("persists an uncertain action failure, pauses fresh input, and redelivers it without replay", async () => {
    const store = memory()
    const first = setup({
      store,
      rejectFail: true,
      actionError: new Error("Windows sent only part of the click input"),
    })
    for (const listener of first.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = first.replies[0] as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    const click: DesktopRequest = {
      id: "desktop_uncertain_1",
      sessionID: "ses_desktop",
      operation: "click",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    for (const listener of first.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)

    expect(first.actions).toHaveLength(1)
    expect(first.rejects).toEqual([
      expect.objectContaining({
        requestID: click.id,
        error: expect.objectContaining({
          message: expect.stringContaining("may have taken effect"),
          receipt: expect.objectContaining({ requestID: click.id, outcome: "unknown" }),
        }),
      }),
    ])
    expect(store.read()).toMatchObject({
      version: 2,
      items: [{ id: click.id, failure: { receipt: { requestID: click.id, outcome: "unknown" } } }],
    })

    const next = { ...request, id: "desktop_after_uncertain_observe" }
    for (const listener of first.events)
      listener({ type: "kilocode.desktop.requested", properties: next } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const frame = first.replies.at(-1) as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    const blocked: DesktopRequest = {
      ...click,
      id: "desktop_after_uncertain_click",
      windowID: frame.result.observation.target.windowID,
      observationID: frame.result.observation.id,
    }
    for (const listener of first.events)
      listener({ type: "kilocode.desktop.requested", properties: blocked } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(first.actions).toHaveLength(1)
    expect(first.rejects.at(-1)).toMatchObject({
      requestID: blocked.id,
      error: { message: expect.stringContaining("Resume agent desktop control") },
    })
    first.bridge.dispose()

    const second = setup({ store, pending: [click] })
    for (const listener of second.states) listener("connected")
    await Bun.sleep(20)
    expect(second.actions).toEqual([])
    expect(second.replies).toEqual([])
    expect(second.rejects).toEqual([
      expect.objectContaining({
        requestID: click.id,
        error: expect.objectContaining({
          receipt: expect.objectContaining({ requestID: click.id, outcome: "unknown" }),
        }),
      }),
    ])
    expect(store.read()).toMatchObject({ version: 2, items: [] })
    second.bridge.dispose()
  })

  it("ignores malformed saved receipts and refuses recovered input", async () => {
    const click: DesktopRequest = {
      id: "desktop_corrupt_1",
      sessionID: "ses_desktop",
      operation: "click",
      windowID: "window_1",
      observationID: "observation_missing",
      sensitive: false,
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    const store = memory({
      version: 1,
      items: [
        {
          id: click.id,
          fingerprint: "0".repeat(64),
          result: {
            operation: "click",
            receipt: {
              version: 1,
              requestID: "different_request",
              startedAt: 1,
              finishedAt: 2,
              effect: "interact",
              outcome: "confirmed",
              observationID: click.observationID,
              target: { surface: "desktop", windowID: click.windowID },
            },
          },
        },
      ],
    })
    const test = setup({ store, pending: [click] })
    for (const listener of test.states) listener("connected")
    await Bun.sleep(20)
    expect(test.actions).toEqual([])
    expect(test.replies).toEqual([])
    expect(test.rejects).toEqual([
      expect.objectContaining({
        requestID: click.id,
        error: expect.objectContaining({
          code: "invalid_request",
          message: expect.stringContaining("journal is invalid"),
        }),
      }),
    ])
    test.bridge.dispose()
  })

  it("moves the pointer once against the exact fresh observation", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    const input = {
      id: "desktop_move_1",
      sessionID: "ses_desktop",
      operation: "move",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      x: 0.75,
      y: 0.125,
    } as DesktopRequest
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: input } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([expect.objectContaining({ operation: "pointer", action: "move", x: 0.75, y: 0.125 })])
    expect(test.replies[1]).toMatchObject({
      requestID: input.id,
      result: { operation: "move", receipt: { effect: "interact", outcome: "confirmed" } },
    })
    test.bridge.dispose()
  })

  it("drags once between exact points against the fresh observation", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    const input = {
      id: "desktop_drag_1",
      sessionID: "ses_desktop",
      operation: "drag",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      startX: 0.2,
      startY: 0.3,
      endX: 0.8,
      endY: 0.7,
      button: "left",
    } as DesktopRequest
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: input } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([
      expect.objectContaining({
        operation: "drag",
        startX: 0.2,
        startY: 0.3,
        endX: 0.8,
        endY: 0.7,
        button: "left",
      }),
    ])
    expect(test.replies[1]).toMatchObject({
      requestID: input.id,
      result: { operation: "drag", receipt: { effect: "interact", outcome: "confirmed" } },
    })
    test.bridge.dispose()
  })

  it("types exact text once against the fresh foreground observation", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    const input: DesktopRequest = {
      id: "desktop_type_1",
      sessionID: "ses_desktop",
      operation: "type",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      text: 'hello `$(Get-ChildItem) "world"',
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: input } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([
      expect.objectContaining({ operation: "type", text: input.text, observationID: input.observationID }),
    ])
    expect(test.replies[1]).toMatchObject({
      requestID: input.id,
      result: { operation: "type", receipt: { effect: "interact", outcome: "confirmed" } },
    })
    test.bridge.dispose()
  })

  it("presses one bounded key chord against the fresh foreground observation", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    const input: DesktopRequest = {
      id: "desktop_key_1",
      sessionID: "ses_desktop",
      operation: "key",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      key: "Enter",
      modifiers: ["control", "shift"],
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: input } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([
      expect.objectContaining({ operation: "key", key: "Enter", modifiers: ["control", "shift"] }),
    ])
    expect(test.replies[1]).toMatchObject({
      requestID: input.id,
      result: { operation: "key", receipt: { effect: "interact", outcome: "confirmed" } },
    })
    test.bridge.dispose()
  })

  it("scrolls once by bounded deltas against the fresh foreground observation", async () => {
    const test = setup()
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    const input: DesktopRequest = {
      id: "desktop_scroll_1",
      sessionID: "ses_desktop",
      operation: "scroll",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      deltaX: 120,
      deltaY: -240,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: input } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(test.actions).toEqual([expect.objectContaining({ operation: "scroll", deltaX: 120, deltaY: -240 })])
    expect(test.replies[1]).toMatchObject({
      requestID: input.id,
      result: { operation: "scroll", receipt: { effect: "interact", outcome: "confirmed" } },
    })
    test.bridge.dispose()
  })

  it("executes a bounded sequence with final-frame and per-step evidence", async () => {
    const test = setup({ dispatchDecision: "allow", pixels: ["start", "clicked", "typed"] })
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as {
      result: { observation: { id: string; target: { windowID: string } } }
    }
    const input: DesktopRequest = {
      id: "desktop_sequence_1",
      sessionID: "ses_desktop",
      operation: "sequence",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      maxDurationMs: 5_000,
      steps: [
        {
          action: {
            operation: "pointer",
            action: "click",
            windowID: "window_1",
            sensitive: false,
            authorization: { kind: "grant", grantID: "grant_test" },
            x: 0.5,
            y: 0.5,
            button: "left",
          },
          preconditions: [{ kind: "control", controlID: "42.7", enabled: true }],
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
        {
          action: {
            operation: "type",
            windowID: "window_1",
            sensitive: false,
            authorization: { kind: "grant", grantID: "grant_test" },
            text: "hello",
          },
          preconditions: [],
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
      ],
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: input } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)

    expect(test.actions.map((action) => (action as { operation: string }).operation)).toEqual(["pointer", "type"])
    expect(test.replies[1]).toMatchObject({
      requestID: input.id,
      result: {
        operation: "sequence",
        status: "completed",
        completed: 2,
        data: "typed",
        observation: { version: 2, sceneVersion: 3 },
        evidence: [
          { step: 1, sceneVersion: 2, postconditions: [{ kind: "pixels", change: "changed" }] },
          { step: 2, sceneVersion: 3, postconditions: [{ kind: "pixels", change: "changed" }] },
        ],
        receipt: { effect: "interact", outcome: "confirmed" },
      },
    })
    test.bridge.dispose()
  })

  it("retains a no-replay receipt without the sequence frame after lost delivery and restart", async () => {
    const store = memory()
    const first = setup({ store, fail: true, pixels: ["initial-frame", "private-final-frame"] })
    for (const listener of first.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = first.replies[0] as { result: { observation: { id: string } } }
    const input: DesktopRequest = {
      id: "desktop_sequence_private_frame",
      sessionID: "ses_desktop",
      operation: "sequence",
      windowID: "window_1",
      observationID: observed.result.observation.id,
      maxDurationMs: 5_000,
      steps: [
        {
          action: {
            operation: "key",
            windowID: "window_1",
            sensitive: false,
            authorization: { kind: "grant", grantID: "grant_test" },
            key: "Tab",
            modifiers: [],
          },
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
      ],
    }
    for (const listener of first.events)
      listener({ type: "kilocode.desktop.requested", properties: input } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(first.actions).toHaveLength(1)
    expect(first.replies[1]).toMatchObject({
      result: { operation: "sequence", status: "completed", data: "private-final-frame" },
    })
    expect(JSON.stringify(store.read())).not.toContain("private-final-frame")
    expect(store.read()).toMatchObject({
      items: [{ id: input.id, failure: { receipt: { outcome: "unknown" } } }],
    })
    first.bridge.dispose()

    const second = setup({ store, pending: [input] })
    for (const listener of second.states) listener("connected")
    await Bun.sleep(20)
    expect(second.actions).toEqual([])
    expect(second.replies).toEqual([])
    expect(second.rejects).toEqual([
      expect.objectContaining({
        requestID: input.id,
        error: expect.objectContaining({ receipt: expect.objectContaining({ outcome: "unknown" }) }),
      }),
    ])
    expect(store.read()).toMatchObject({ version: 2, items: [] })
    second.bridge.dispose()

    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["C:\\workspace", input]))
      .digest("hex")
    let saved: unknown = {
      version: 1,
      items: [{ id: input.id, fingerprint, result: (first.replies[1] as { result: unknown }).result }],
    }
    let failures = 1
    const legacy = {
      get: <T>() => saved as T,
      update: async (_key: string, value: unknown) => {
        if (failures-- > 0) throw new Error("temporary storage failure")
        saved = structuredClone(value)
      },
      read: () => saved,
    }
    const third = setup({ store: legacy, pending: [input] })
    await Bun.sleep(20)
    expect(JSON.stringify(legacy.read())).toContain("private-final-frame")
    for (const listener of third.states) listener("connected")
    await Bun.sleep(20)
    expect(third.actions).toEqual([])
    expect(third.rejects).toEqual([
      expect.objectContaining({
        requestID: input.id,
        error: expect.objectContaining({ receipt: expect.objectContaining({ outcome: "unknown" }) }),
      }),
    ])
    expect(JSON.stringify(legacy.read())).not.toContain("private-final-frame")
    third.bridge.dispose()
  })

  it("records an unknown receipt when the grant is revoked after a sequence effect", async () => {
    let checks = 0
    const store = memory()
    const test = setup({
      store,
      rejectFail: true,
      pixels: ["start", "effect"],
      dispatch: () => (++checks === 3 ? "deny" : "allow"),
    })
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as { result: { observation: { id: string } } }
    const input: DesktopRequest = {
      id: "desktop_sequence_revoked_after_effect",
      sessionID: "ses_desktop",
      operation: "sequence",
      windowID: "window_1",
      observationID: observed.result.observation.id,
      maxDurationMs: 5_000,
      steps: [
        {
          action: {
            operation: "key",
            windowID: "window_1",
            sensitive: false,
            authorization: { kind: "grant", grantID: "grant_test" },
            key: "Tab",
            modifiers: [],
          },
          preconditions: [],
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
      ],
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: input } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)

    expect(test.actions).toHaveLength(1)
    expect(test.rejects[0]).toMatchObject({
      requestID: input.id,
      error: { receipt: { effect: "interact", outcome: "unknown", observationID: input.observationID } },
    })
    expect(store.read()).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ id: input.id, failure: expect.objectContaining({ receipt: expect.anything() }) }),
        ],
      }),
    )
    test.bridge.dispose()
  })

  it("persists an unknown no-replay receipt when a later sequence lease check denies", async () => {
    let checks = 0
    const store = memory()
    const test = setup({
      store,
      rejectFail: true,
      pixels: ["start", "first-effect"],
      dispatch: () => (++checks === 3 ? "deny" : "allow"),
    })
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as { result: { observation: { id: string } } }
    const input: DesktopRequest = {
      id: "desktop_sequence_denied",
      sessionID: "ses_desktop",
      operation: "sequence",
      windowID: "window_1",
      observationID: observed.result.observation.id,
      maxDurationMs: 5_000,
      steps: [
        {
          action: {
            operation: "key",
            windowID: "window_1",
            sensitive: false,
            authorization: { kind: "grant", grantID: "grant_test" },
            key: "Tab",
            modifiers: [],
          },
          preconditions: [],
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
        {
          action: {
            operation: "key",
            windowID: "window_1",
            sensitive: false,
            authorization: { kind: "grant", grantID: "grant_test" },
            key: "Enter",
            modifiers: [],
          },
          preconditions: [],
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
      ],
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: input } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)

    expect(test.actions).toHaveLength(1)
    expect(test.rejects[0]).toMatchObject({
      requestID: input.id,
      error: { receipt: { effect: "interact", outcome: "unknown", observationID: input.observationID } },
    })
    expect(store.read()).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ id: input.id, failure: expect.objectContaining({ receipt: expect.anything() }) }),
        ],
      }),
    )
    test.bridge.dispose()
  })

  async function native(test: ReturnType<typeof setup>, id: string) {
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: request } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    const observed = test.replies[0] as { result: { observation: { id: string; target: { windowID: string } } } }
    const click: DesktopRequest = {
      id,
      sessionID: "ses_desktop",
      operation: "click",
      windowID: observed.result.observation.target.windowID,
      observationID: observed.result.observation.id,
      sensitive: false,
      action: "click",
      button: "left",
      x: 0.5,
      y: 0.25,
    }
    for (const listener of test.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    return click
  }

  it("keeps v2 epoch and pending counts across restart, then atomically records native acknowledgement", async () => {
    const store = memory()
    const first = setup({ store, fail: true })
    const click = await native(first, "journal_v2_restart")
    const pending = first.bridge.journalSummary()
    expect(first.bridge.journalState()).toBe("durable")
    expect(first.actions).toHaveLength(1)
    expect(pending).toMatchObject({ revision: 1, lastAckAt: null, pendingNative: { confirmed: 1, unknown: 0 } })
    expect(JSON.stringify(first.bridge.journalSummary())).not.toContain(click.id)
    first.bridge.dispose()

    const second = setup({ store, pending: [click] })
    expect(second.bridge.journalState()).toBe("durable")
    expect(second.bridge.journalSummary()).toEqual(pending)
    for (const listener of second.states) listener("connected")
    await Bun.sleep(20)
    expect(second.actions).toEqual([])
    expect(second.replies).toHaveLength(1)
    const ack = second.bridge.journalSummary()
    expect(ack).toMatchObject({
      epoch: pending?.epoch,
      revision: 2,
      pendingNative: { confirmed: 0, unknown: 0 },
    })
    expect(ack?.lastAckAt).toBeGreaterThan(0)
    second.bridge.dispose()
    const third = setup({ store })
    expect(third.bridge.journalSummary()).toEqual(ack)
    third.bridge.dispose()
  })

  it("migrates v1 unknown receipts without replay or inventing a historical acknowledgement", async () => {
    const store = memory()
    const first = setup({ store, rejectFail: true, actionError: new Error("partial native input") })
    const click = await native(first, "journal_v1_unknown")
    const saved = store.read() as { items: unknown[] }
    await store.update("raya.computerUse.desktop.actionReceipts.v1", { version: 1, items: saved.items })
    first.bridge.dispose()

    const second = setup({ store, pending: [click] })
    expect(second.bridge.journalState()).toBe("migrating_legacy")
    await Bun.sleep(20)
    expect(second.bridge.journalState()).toBe("durable")
    expect(second.bridge.journalSummary()).toMatchObject({
      revision: 1,
      lastAckAt: null,
      pendingNative: { confirmed: 0, unknown: 1 },
    })
    for (const listener of second.states) listener("connected")
    await Bun.sleep(20)
    expect(second.actions).toEqual([])
    expect(second.rejects).toHaveLength(1)
    expect(second.bridge.journalSummary()).toMatchObject({ pendingNative: { confirmed: 0, unknown: 0 } })
    expect(second.bridge.journalSummary()?.lastAckAt).toBeGreaterThan(0)
    second.bridge.dispose()
  })

  it("keeps the last durable pending receipt when acknowledgement persistence fails", async () => {
    let saved: unknown
    let fail = false
    const store = {
      get: <T>() => saved as T | undefined,
      update: async (_key: string, value: unknown) => {
        if (fail) throw new Error("storage unavailable")
        saved = structuredClone(value)
      },
    }
    const first = setup({ store, fail: true })
    const click = await native(first, "journal_ack_failure")
    const pending = first.bridge.journalSummary()
    first.bridge.dispose()
    fail = true

    const second = setup({ store, pending: [click] })
    for (const listener of second.states) listener("connected")
    await Bun.sleep(20)
    expect(second.actions).toEqual([])
    expect(second.bridge.journalSummary()).toEqual(pending)
    expect((saved as { version: number; items: Array<{ id: string }> }).version).toBe(2)
    expect((saved as { items: Array<{ id: string }> }).items[0].id).toBe(click.id)
    for (const listener of second.events)
      listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
    await Bun.sleep(20)
    expect(second.actions).toEqual([])
    expect(second.bridge.journalSummary()).toEqual(pending)
    second.bridge.dispose()
    fail = false

    const third = setup({ store, pending: [click] })
    for (const listener of third.states) listener("connected")
    await Bun.sleep(20)
    expect(third.actions).toEqual([])
    expect(third.bridge.journalSummary()).toMatchObject({
      epoch: pending?.epoch,
      pendingNative: { confirmed: 0, unknown: 0 },
    })
    expect(third.bridge.journalSummary()?.lastAckAt).toBeGreaterThan(0)
    third.bridge.dispose()
  })

  it("refuses native dispatch when v2 journal metadata is malformed or oversized", async () => {
    for (const saved of [
      { version: 2, epoch: "forged", revision: 1, lastAckAt: null, items: [] },
      { version: 2, epoch: randomUUID(), revision: 1, lastAckAt: null, items: Array(257).fill({}) },
    ]) {
      const test = setup({ store: memory(saved) })
      expect(test.bridge.journalState()).toBe("malformed")
      expect(test.bridge.journalSummary()).toBeNull()
      const click: DesktopRequest = {
        id: "corrupt_journal_click",
        sessionID: "ses_desktop",
        operation: "click",
        windowID: "window_1",
        observationID: "stale",
        sensitive: false,
        action: "click",
        button: "left",
        x: 0.5,
        y: 0.25,
      }
      for (const listener of test.events)
        listener({ type: "kilocode.desktop.requested", properties: click } as SSEPayload, "C:\\workspace")
      await Bun.sleep(20)
      expect(test.actions).toEqual([])
      expect(test.rejects).toContainEqual(
        expect.objectContaining({
          error: expect.objectContaining({ message: expect.stringContaining("journal is invalid") }),
        }),
      )
      test.bridge.dispose()
    }
  })

  it("refuses a duplicate saved native receipt instead of replaying it", async () => {
    const store = memory()
    const first = setup({ store, fail: true })
    const click = await native(first, "journal_duplicate")
    const saved = store.read() as { version: 2; epoch: string; revision: number; lastAckAt: null; items: unknown[] }
    await store.update("raya.computerUse.desktop.actionReceipts.v1", {
      ...saved,
      items: [saved.items[0], saved.items[0]],
    })
    first.bridge.dispose()
    const second = setup({ store, pending: [click] })
    expect(second.bridge.journalSummary()).toBeNull()
    for (const listener of second.states) listener("connected")
    await Bun.sleep(20)
    expect(second.actions).toEqual([])
    expect(second.rejects).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: expect.stringContaining("journal is invalid") }),
      }),
    )
    second.bridge.dispose()
  })
})
