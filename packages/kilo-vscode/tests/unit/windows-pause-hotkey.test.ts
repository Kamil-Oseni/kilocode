import { describe, expect, it } from "bun:test"
import { WindowsPauseHotkey } from "../../src/services/computer-use/windows-pause-hotkey"

function harness() {
  const listeners: {
    data?: (value: string) => void
    error?: (error: Error) => void
    exit?: (code: number | null, signal: NodeJS.Signals | null) => void
  } = {}
  const state = { script: "", killed: 0 }
  return {
    listeners,
    state,
    launch: (script: string) => {
      state.script = script
      return {
        data: (listener: (value: string) => void) => {
          listeners.data = listener
        },
        error: (listener: (error: Error) => void) => {
          listeners.error = listener
        },
        exit: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => {
          listeners.exit = listener
        },
        kill: () => {
          state.killed += 1
        },
      }
    },
  }
}

describe("Windows global Pause Raya shortcut", () => {
  it("registers Ctrl+Alt+Shift+Escape and emits every complete pause line", () => {
    const test = harness()
    const state = { pauses: 0, manuals: 0, losses: 0 }
    const hotkey = new WindowsPauseHotkey(
      () => {
        state.pauses += 1
      },
      () => {
        state.manuals += 1
      },
      () => {
        state.losses += 1
      },
      test.launch,
    )

    expect(test.state.script).toContain("RegisterHotKey")
    const id = Number(test.state.script.match(/\$id = (0x[\da-f]+)/i)?.[1])
    expect(id).toBe(0x5241)
    expect(id).toBeGreaterThanOrEqual(0)
    expect(id).toBeLessThanOrEqual(0xbfff)
    expect(test.state.script).not.toContain("$id = 0x52415941")
    expect(test.state.script).toContain("0x4007, 0x1B")
    expect(test.state.script).toContain("SetWindowsHookEx(13")
    expect(test.state.script).toContain("SetWindowsHookEx(14")
    expect(test.state.script).toContain("(input.Flags & 0x12) == 0")
    expect(test.state.script).toContain("(input.Flags & 0x3) == 0")
    expect(test.state.script).toContain("Environment.TickCount64 + 750")
    expect(test.state.script).toContain("UnhookWindowsHookEx")
    expect(test.state.script).toContain("UnregisterHotKey")
    test.listeners.data?.("pau")
    test.listeners.data?.("se\r\nmanual\npause\nnoise\n")
    expect(state).toEqual({ pauses: 2, manuals: 1, losses: 0 })
    hotkey.dispose()
    expect(test.state.killed).toBe(1)
  })

  it("fails closed once on host loss and ignores disposal exit", () => {
    const test = harness()
    const state = { losses: 0 }
    const hotkey = new WindowsPauseHotkey(
      () => {},
      () => {},
      () => {
        state.losses += 1
      },
      test.launch,
    )
    test.listeners.error?.(new Error("driver lost"))
    test.listeners.exit?.(1, null)
    expect(state.losses).toBe(1)
    hotkey.dispose()
    test.listeners.exit?.(null, "SIGTERM")
    expect(state.losses).toBe(1)
  })
})
