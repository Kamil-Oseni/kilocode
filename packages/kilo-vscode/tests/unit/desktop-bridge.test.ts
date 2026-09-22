import { describe, expect, it } from "bun:test"
import type { DesktopRequest, KiloClient } from "@kilocode/sdk/v2/client"
import {
  DesktopBridge,
  type DesktopConnection,
  type DesktopReceiptStore,
} from "../../src/services/computer-use/desktop-bridge"
import { DesktopSession, type DesktopDriver } from "../../src/services/computer-use/desktop-session"
import type { ConnectionState } from "../../src/services/cli-backend/connection-service"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"

const request: DesktopRequest = { id: "desktop_1", sessionID: "ses_desktop", operation: "observe" }

function setup(
  input: {
    store?: DesktopReceiptStore
    pending?: DesktopRequest[]
    fail?: boolean
    rejectFail?: boolean
    actionError?: Error
    hold?: Promise<void>
  } = {},
) {
  const replies: unknown[] = []
  const rejects: unknown[] = []
  const actions: unknown[] = []
  const focused: string[] = []
  const events = new Set<(event: SSEPayload, directory?: string) => void>()
  const states = new Set<(state: ConnectionState, error?: Error) => void>()
  const driver: DesktopDriver = {
    observe: async () => ({
      windowID: "window_1",
      location: "process|title|bounds",
      width: 20,
      height: 10,
      mime: "image/png",
      data: "cG5n",
    }),
    windows: async () => [
      {
        windowID: "window_2",
        location: "pid:7;class:Browser;title:Browser",
        title: "Browser",
        processID: 7,
        x: 40,
        y: 20,
        width: 1000,
        height: 700,
        minimized: false,
        foreground: false,
      },
    ],
    current: async () => ({ windowID: "window_1", location: "process|title|bounds" }),
    focus: async (target) => {
      focused.push(target.windowID)
    },
    perform: async (action) => {
      actions.push(action)
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
  )
  return { bridge, events, states, replies, rejects, actions, focused, observed: () => observed }
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
          { width: 20, height: 10, observation: { target: { surface: "desktop", windowID: "window_1" } } },
          { width: 20, height: 10, observation: { target: { surface: "desktop", windowID: "window_1" } } },
          { width: 20, height: 10, observation: { target: { surface: "desktop", windowID: "window_1" } } },
        ],
        receipt: { requestID: watch.id, effect: "observe", outcome: "confirmed" },
      },
    })
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
      version: 1,
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
    expect(store.read()).toEqual({ version: 1, items: [] })
    second.bridge.dispose()
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
      version: 1,
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
    expect(store.read()).toEqual({ version: 1, items: [] })
    second.bridge.dispose()
  })

  it("ignores malformed saved receipts and refuses recovered input", async () => {
    const click: DesktopRequest = {
      id: "desktop_corrupt_1",
      sessionID: "ses_desktop",
      operation: "click",
      windowID: "window_1",
      observationID: "observation_missing",
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
          message: expect.stringContaining("prior outcome is unknown"),
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
})
