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
    expect(test.scripts[0]).toContain("$visible.Left = [Math]::Max($rect.Left, $desktopLeft)")
    expect(test.scripts[0]).toContain("$visible.Right = [Math]::Min($rect.Right, $desktopLeft + $desktopWidth)")
    expect(test.scripts[0]).toContain("Rect = $visible")
    expect(test.scripts[0]).toContain("$area = [double]$window.Width * [double]$window.Height")
    expect(test.scripts[0]).toContain("StretchBlt(destination, 0, 0, targetWidth, targetHeight")
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::Capture($context, $width, $height")
    expect(test.scripts[0]).not.toContain("$tileSize")
    expect(test.scripts[0]).toContain("New-Object RayaBoundedStream 15000000")
    expect(test.scripts[0]).toContain('$mime = "image/jpeg"')
    expect(test.scripts[0]).toContain("function Test-RayaImage($stream)")
    expect(test.scripts[0]).toContain("[Drawing.Image]::FromStream($stream, $false, $true)")
    expect(test.scripts[0]).toContain(
      'throw new InvalidOperationException("Desktop capture exceeds the encoded image limit")',
    )
    expect(test.scripts[0]).toContain("$stream.GetBuffer(), 0, [int]$stream.Length")
    expect(test.scripts[0]).not.toContain("$stream.ToArray()")
    expect(test.scripts[0]).toContain("width = $width")
    expect(test.scripts[0]).toContain("height = $height")
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
    expect(test.scripts[1]).toContain("ValidateIdleInput()")
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

  it("batches drag positioning, down, movement, and release with recovery", async () => {
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

    expect(test.scripts[0]).toContain("SendInput(4, inputs")
    expect(test.scripts[0]).toContain("Mouse(up, 0)")
    expect(test.scripts[0]).toContain("GetSystemMetrics(76)")
    expect(test.scripts[0]).toContain("ValidatePoint(expectedStartX, expectedStartY)")
    expect(test.scripts[0]).toContain("ValidatePoint(expectedEndX, expectedEndY)")
    expect(test.scripts[0]).toContain("ValidateTarget(expectedStartX, expectedStartY)")
    expect(test.scripts[0]).toContain("ValidateTarget(expectedEndX, expectedEndY)")
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Move($startX, $startY)")
    expect(test.scripts[0]).toContain(
      "[RayaDesktopNative]::Drag($absoluteStartX, $absoluteStartY, $absoluteEndX, $absoluteEndY, $startX, $startY, $endX, $endY, $down, $up)",
    )
    expect(test.scripts[0]).toContain("Windows did not finish the drag at the exact desktop point")
  })

  it("batches click positioning, press, and release with recovery", async () => {
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

    expect(test.scripts[0]).toContain("SendInput((uint)batch.Length, batch")
    expect(test.scripts[0]).toContain("Mouse(up, 0)")
    expect(test.scripts[0]).toContain(
      '[RayaDesktopNative]::Click($absoluteX, $absoluteY, $x, $y, $down, $up, $action.action -eq "double_click")',
    )
    expect(test.scripts[0]).toContain("Windows did not click the exact desktop point")
    expect(test.scripts[0]).toContain("ValidateTarget(expectedX, expectedY)")
    expect(test.scripts[0]).toContain("Another application covers the grounded desktop point")
    expect(test.scripts[0]).toContain("GetAsyncKeyState(key) & 0x8000")
    expect(test.scripts[0]).toContain("Manual keyboard or pointer input is held")
    expect(test.scripts[0]).toContain('if ($action.action -eq "move") {')
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Mouse($down, 0)")
  })

  it("refuses off-screen pointer movement and verifies exact native placement", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    await driver.perform(
      {
        operation: "pointer",
        action: "move",
        windowID: "0x123",
        observationID: "obs-point",
        x: 0.5,
        y: 0.5,
        button: "left",
      },
      { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" },
    )

    expect(test.scripts[0]).toContain("ValidatePoint(x, y)")
    expect(test.scripts[0]).toContain("ValidateTarget(x, y)")
    expect(test.scripts[0]).toContain("WindowFromPoint(new Point { X = x, Y = y })")
    expect(test.scripts[0]).toContain("GetCursorPos(out point)")
    expect(test.scripts[0]).toContain("Desktop point is outside the physical virtual desktop")
    expect(test.scripts[0]).toContain("[RayaDesktopNative]::Move($x, $y)")
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::SetCursorPos($x, $y)")
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
    expect(test.scripts[0]).toContain(
      "public static void Chord(ushort key, ushort[] modifiers) {\n    ValidateIdleInput();",
    )
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Key($key, $false)")
  })

  it("batches complete Unicode text and recovers an unmatched key-down after partial dispatch", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    await driver.perform(
      { operation: "type", windowID: "0x123", observationID: "obs-type", text: "A" },
      { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" },
    )

    expect(test.scripts[0]).toContain("new Input[checked(text.Length * 2)]")
    expect(test.scripts[0]).toContain("public static void Text(string text) {\n    ValidateIdleInput();")
    expect(test.scripts[0]).toContain("SendInput((uint)inputs.Length, inputs")
    expect(test.scripts[0]).toContain("accepted % 2 == 1")
    expect(test.scripts[0]).toContain("inputs[accepted]")
    expect(test.scripts[0]).not.toContain("foreach (var character in text)")
    expect(test.scripts[0]).toContain("Windows refused complete desktop text input")
  })

  it("batches both scroll axes into one native dispatch", async () => {
    const test = harness([""])
    const driver = new WindowsDesktopDriver(test.runner)
    await driver.perform(
      {
        operation: "scroll",
        windowID: "0x123",
        observationID: "obs-scroll",
        deltaX: -120,
        deltaY: 240,
      },
      { windowID: "0x123", location: "pid:5;title:Editor;bounds:0,0,1280,720" },
    )

    expect(test.scripts[0]).toContain("unchecked((uint)deltaY)")
    expect(test.scripts[0]).toContain("unchecked((uint)deltaX)")
    expect(test.scripts[0]).toContain("SendInput((uint)batch.Length, batch")
    expect(test.scripts[0]).toContain("Windows refused complete desktop scroll input")
    expect(test.scripts[0]).toContain("public static void Scroll(int deltaX, int deltaY) {\n    ValidateIdleInput();")
    expect(test.scripts[0]).toContain(
      "[RayaDesktopNative]::Scroll([int][Math]::Round($action.deltaX), [int][Math]::Round($action.deltaY))",
    )
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Mouse(0x0800, $data)")
    expect(test.scripts[0]).not.toContain("[RayaDesktopNative]::Mouse(0x1000, $data)")
  })

  it("rejects malformed native output", async () => {
    const test = harness([JSON.stringify({ windowID: "0x123" })])
    const driver = new WindowsDesktopDriver(test.runner)
    await expect(driver.observe()).rejects.toThrow(/observation is incomplete/i)
  })

  it("rejects native observations outside the bounded capture envelope", async () => {
    const test = harness([
      JSON.stringify({
        windowID: "0x123",
        location: "pid:5;title:Editor;bounds:0,0,8192,2160",
        width: 4097,
        height: 2023,
        mime: "image/png",
        data: "png",
      }),
      JSON.stringify({
        windowID: "0x123",
        location: "pid:5;title:Editor;bounds:0,0,4096,4096",
        width: 4096,
        height: 4096,
        mime: "image/png",
        data: "png",
      }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    await expect(driver.observe()).rejects.toThrow(/observation is incomplete/i)
    await expect(driver.observe()).rejects.toThrow(/observation is incomplete/i)
  })

  it("accepts the bounded JPEG fallback", async () => {
    const test = harness([
      JSON.stringify({
        windowID: "0x123",
        location: "pid:5;title:Editor;bounds:0,0,3840,2160",
        width: 3840,
        height: 2160,
        mime: "image/jpeg",
        data: "jpeg",
      }),
    ])
    const driver = new WindowsDesktopDriver(test.runner)

    expect(await driver.observe()).toMatchObject({ width: 3840, height: 2160, mime: "image/jpeg", data: "jpeg" })
  })
})
