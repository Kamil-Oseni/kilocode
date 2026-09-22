import { describe, expect, it } from "bun:test"
import { WindowsDesktopDriver } from "../../src/services/computer-use/desktop-windows"

function harness(outputs: string[]) {
  const scripts: string[] = []
  let cancelled = 0
  return {
    scripts,
    cancelled: () => cancelled,
    runner: {
      run: async (script: string) => {
        scripts.push(script)
        return outputs.shift() ?? ""
      },
      cancel: () => {
        cancelled += 1
      },
    },
  }
}

describe("Windows native desktop driver", () => {
  it("parses foreground-window observations and identity", async () => {
    const test = harness([
      JSON.stringify({
        windowID: "0x123",
        location: "pid:5;title:Editor;bounds:0,0,1280,720",
        width: 1280,
        height: 720,
        mime: "image/png",
        data: "png",
      }),
      JSON.stringify({ windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    expect(await driver.observe()).toMatchObject({ windowID: "0x123", width: 1280, height: 720, data: "png" })
    expect(await driver.current()).toEqual({
      windowID: "0x123",
      location: "pid:5;title:Editor;bounds:0,0,1280,720",
    })
    expect(test.scripts[0]).toContain("CopyFromScreen")
    expect(test.scripts[0]).toContain("SetThreadDpiAwarenessContext(new IntPtr(-4))")
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::EnableDpiAwareness()")
    expect(test.scripts[0]).toContain("desktop coordinates are unsafe")
    expect(test.scripts[1]).not.toContain("CopyFromScreen")
    expect(test.scripts[1]).toContain("[RayaDesktopNative]::EnableDpiAwareness()")
  })

  it("lists visible windows and focuses an exact encoded identity", async () => {
    const test = harness([
      JSON.stringify({
        windows: [
          {
            windowID: "0x123",
            location: "pid:5;class:Editor;title:Editor",
            title: "Editor",
            processID: 5,
            x: 10,
            y: 20,
            width: 1280,
            height: 720,
            minimized: false,
            foreground: true,
          },
        ],
      }),
      "",
    ])
    const driver = new WindowsDesktopDriver(test.runner)
    const windows = await driver.windows()
    await driver.focus(windows[0])

    expect(windows).toEqual([
      expect.objectContaining({ windowID: "0x123", title: "Editor", processID: 5, foreground: true }),
    ])
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::Windows()")
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::EnableDpiAwareness()")
    expect(test.scripts[1]).not.toContain(windows[0].location)
    expect(test.scripts[1]).toContain(Buffer.from(JSON.stringify(windows[0]), "utf8").toString("base64"))
    expect(test.scripts[1]).toContain("[RayaDesktopNative]::Focus")
    expect(test.scripts[1]).toContain("[RayaDesktopNative]::EnableDpiAwareness()")
    expect(test.scripts[1]).toContain("AttachThreadInput")
    expect(test.scripts[1]).toContain("attempt < 10")
  })

  it("passes actions as encoded JSON instead of interpolated text", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    const text = 'hello `$(Get-ChildItem) "world"'
    const action = { operation: "type" as const, windowID: "0x123", observationID: "obs-1", text }
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" }
    await driver.perform(action, target)

    expect(test.scripts[0]).not.toContain(text)
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::EnableDpiAwareness()")
    expect(test.scripts[0]).toContain(Buffer.from(JSON.stringify({ action, target }), "utf8").toString("base64"))
    driver.cancel()
    expect(test.cancelled()).toBe(1)
  })

  it("batches drag down, movement, and release with a recovery release", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    const action = {
      operation: "drag" as const,
      windowID: "0x123",
      observationID: "obs-drag",
      startX: 0.2,
      startY: 0.3,
      endX: 0.8,
      endY: 0.7,
      button: "left" as const,
    }
    await driver.perform(action, { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" })

    expect(test.scripts[0]).toContain("SendInput(3, inputs")
    expect(test.scripts[0]).toContain("Mouse(up, 0)")
    expect(test.scripts[0]).toContain("GetSystemMetrics(76)")
  })

  it("batches click press and release with a recovery release", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    await driver.perform(
      {
        operation: "pointer",
        action: "double_click",
        windowID: "0x123",
        observationID: "obs-click",
        x: 0.25,
        y: 0.75,
        button: "right",
      },
      { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" },
    )

    expect(test.scripts[0]).toContain("SendInput((uint)inputs.Length, inputs")
    expect(test.scripts[0]).toContain("Mouse(up, 0)")
    expect(test.scripts[0]).toContain('[RayaDesktopNative]::Click($down, $up, $action.action -eq "double_click")')
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Mouse($down, 0)")
  })

  it("batches complete key chords and recovers every release after partial dispatch", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    await driver.perform(
      {
        operation: "key",
        windowID: "0x123",
        observationID: "obs-key",
        key: "Enter",
        modifiers: ["control", "shift"],
      },
      { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" },
    )

    expect(test.scripts[0]).toContain("new Input[(modifiers.Length * 2) + 2]")
    expect(test.scripts[0]).toContain("Release(key)")
    expect(test.scripts[0]).toContain("Release(modifiers[position])")
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::Chord([uint16]$key, [uint16[]]$held)")
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Key($key, $false)")
  })

  it("attempts Unicode key-up recovery after partial text dispatch", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    await driver.perform(
      { operation: "type", windowID: "0x123", observationID: "obs-type", text: "A" },
      { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" },
    )

    expect(test.scripts[0]).toContain("SendInput(1, new[] { up }")
    expect(test.scripts[0]).toContain("Windows refused complete desktop text input")
  })

  it("rejects malformed native output", async () => {
    const test = harness([JSON.stringify({ windowID: "0x123" })])
    const driver = new WindowsDesktopDriver(test.runner)
    await expect(driver.observe()).rejects.toThrow(/observation is incomplete/i)
  })
})
