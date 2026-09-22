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
    expect(test.scripts[1]).not.toContain("CopyFromScreen")
  })

  it("passes actions as encoded JSON instead of interpolated text", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    const text = 'hello `$(Get-ChildItem) "world"'
    const action = { operation: "type" as const, windowID: "0x123", observationID: "obs-1", text }
    const target = { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" }
    await driver.perform(action, target)

    expect(test.scripts[0]).not.toContain(text)
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

  it("rejects malformed native output", async () => {
    const test = harness([JSON.stringify({ windowID: "0x123" })])
    const driver = new WindowsDesktopDriver(test.runner)
    await expect(driver.observe()).rejects.toThrow(/observation is incomplete/i)
  })
})
