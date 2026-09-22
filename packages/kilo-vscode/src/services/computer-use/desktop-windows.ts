import { execFile, type ChildProcess } from "node:child_process"
import type { DesktopAction, DesktopDriver, DesktopFrame } from "./desktop-session"

const native = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class RayaDesktopNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct Input { public uint Type; public InputUnion Value; }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MouseInput Mouse;
    [FieldOffset(0)] public KeyboardInput Keyboard;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MouseInput {
    public int X;
    public int Y;
    public uint Data;
    public uint Flags;
    public uint Time;
    public IntPtr Extra;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KeyboardInput {
    public ushort VirtualKey;
    public ushort Scan;
    public uint Flags;
    public uint Time;
    public IntPtr Extra;
  }

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, Input[] inputs, int size);

  public static void Mouse(uint flags, uint data) {
    var input = new Input {
      Type = 0,
      Value = new InputUnion { Mouse = new MouseInput { Flags = flags, Data = data } }
    };
    if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) != 1) throw new InvalidOperationException("Windows refused desktop mouse input");
  }

  public static void Key(ushort key, bool up) {
    var input = new Input {
      Type = 1,
      Value = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = key, Flags = up ? 2u : 0u } }
    };
    if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) != 1) throw new InvalidOperationException("Windows refused desktop keyboard input");
  }

  public static void Text(string text) {
    foreach (var character in text) {
      var down = new Input {
        Type = 1,
        Value = new InputUnion { Keyboard = new KeyboardInput { Scan = character, Flags = 4u } }
      };
      var up = down;
      up.Value.Keyboard.Flags = 6u;
      if (SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(Input))) != 2) throw new InvalidOperationException("Windows refused desktop text input");
    }
  }
}
`

const setup = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Add-Type -TypeDefinition @'
${native}
'@

function Get-RayaWindow {
  $handle = [RayaDesktopNative]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { throw "Windows has no foreground window" }
  $rect = New-Object RayaDesktopNative+Rect
  if (-not [RayaDesktopNative]::GetWindowRect($handle, [ref]$rect)) { throw "Windows refused foreground window bounds" }
  $title = New-Object Text.StringBuilder 2048
  [void][RayaDesktopNative]::GetWindowText($handle, $title, $title.Capacity)
  [uint32]$processID = 0
  [void][RayaDesktopNative]::GetWindowThreadProcessId($handle, [ref]$processID)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw "Foreground window has no observable area" }
  [pscustomobject]@{
    Handle = $handle
    Rect = $rect
    WindowID = ("0x{0:X}" -f $handle.ToInt64())
    Location = ("pid:{0};title:{1};bounds:{2},{3},{4},{5}" -f $processID, $title.ToString(), $rect.Left, $rect.Top, $width, $height)
    Width = $width
    Height = $height
  }
}
`

const observe = `${setup}
Add-Type -AssemblyName System.Drawing
$window = Get-RayaWindow
$image = New-Object Drawing.Bitmap $window.Width, $window.Height
$graphics = [Drawing.Graphics]::FromImage($image)
$stream = New-Object IO.MemoryStream
try {
  $graphics.CopyFromScreen($window.Rect.Left, $window.Rect.Top, 0, 0, $image.Size, [Drawing.CopyPixelOperation]::SourceCopy)
  $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
  [pscustomobject]@{
    windowID = $window.WindowID
    location = $window.Location
    width = $window.Width
    height = $window.Height
    mime = "image/png"
    data = [Convert]::ToBase64String($stream.ToArray())
  } | ConvertTo-Json -Compress
} finally {
  $stream.Dispose()
  $graphics.Dispose()
  $image.Dispose()
}
`

const current = `${setup}
$window = Get-RayaWindow
[pscustomobject]@{ windowID = $window.WindowID; location = $window.Location } | ConvertTo-Json -Compress
`

function payload(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64")
}

function perform(action: DesktopAction, target: { windowID: string; location?: string }) {
  const input = payload({ action, target })
  return `${setup}
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${input}")) | ConvertFrom-Json
$window = Get-RayaWindow
if ($window.WindowID -ne $payload.target.windowID -or $window.Location -ne $payload.target.location) { throw "Foreground window changed before desktop input" }
$action = $payload.action

switch ($action.operation) {
  "pointer" {
    $x = $window.Rect.Left + [Math]::Min($window.Width - 1, [Math]::Max(0, [Math]::Round($action.x * ($window.Width - 1))))
    $y = $window.Rect.Top + [Math]::Min($window.Height - 1, [Math]::Max(0, [Math]::Round($action.y * ($window.Height - 1))))
    if (-not [RayaDesktopNative]::SetCursorPos($x, $y)) { throw "Windows refused desktop pointer movement" }
    if ($action.action -eq "move") { break }
    $down = if ($action.button -eq "right") { 0x0008 } else { 0x0002 }
    $up = if ($action.button -eq "right") { 0x0010 } else { 0x0004 }
    [RayaDesktopNative]::Mouse($down, 0)
    [RayaDesktopNative]::Mouse($up, 0)
    if ($action.action -eq "double_click") {
      [RayaDesktopNative]::Mouse($down, 0)
      [RayaDesktopNative]::Mouse($up, 0)
    }
  }
  "type" { [RayaDesktopNative]::Text([string]$action.text) }
  "scroll" {
    if ($action.deltaY -ne 0) {
      $data = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32][Math]::Round($action.deltaY)), 0)
      [RayaDesktopNative]::Mouse(0x0800, $data)
    }
    if ($action.deltaX -ne 0) {
      $data = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32][Math]::Round($action.deltaX)), 0)
      [RayaDesktopNative]::Mouse(0x1000, $data)
    }
  }
  "key" {
    $keys = @{
      "Backspace" = 0x08; "Tab" = 0x09; "Enter" = 0x0D; "Shift" = 0x10; "Control" = 0x11;
      "Alt" = 0x12; "Escape" = 0x1B; "Space" = 0x20; "PageUp" = 0x21; "PageDown" = 0x22;
      "End" = 0x23; "Home" = 0x24; "ArrowLeft" = 0x25; "ArrowUp" = 0x26; "ArrowRight" = 0x27;
      "ArrowDown" = 0x28; "Delete" = 0x2E; "Meta" = 0x5B;
    }
    $mods = @{ "shift" = 0x10; "control" = 0x11; "alt" = 0x12; "meta" = 0x5B }
    $held = @()
    foreach ($modifier in @($action.modifiers)) {
      $code = $mods[[string]$modifier]
      if (-not $code) { throw "Unsupported desktop modifier" }
      [RayaDesktopNative]::Key($code, $false)
      $held += $code
    }
    $name = [string]$action.key
    $key = $keys[$name]
    if (-not $key -and $name.Length -eq 1) { $key = [int][char]$name.ToUpperInvariant() }
    if (-not $key -and $name -match '^F([1-9]|1[0-2])$') { $key = 0x6F + [int]$Matches[1] }
    if (-not $key) { throw "Unsupported desktop key" }
    try {
      [RayaDesktopNative]::Key($key, $false)
      [RayaDesktopNative]::Key($key, $true)
    } finally {
      [array]::Reverse($held)
      foreach ($code in $held) { [RayaDesktopNative]::Key($code, $true) }
    }
  }
}
`
}

type Runner = { run(script: string): Promise<string>; cancel(): void }

function runner(): Runner {
  let child: ChildProcess | undefined
  return {
    run: (script) =>
      new Promise((resolve, reject) => {
        if (child) {
          reject(new Error("A Windows desktop driver command is already active"))
          return
        }
        const process = execFile(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::In.ReadToEnd() | Invoke-Expression"],
          { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (child === process) child = undefined
            if (error) {
              reject(new Error((stderr.trim() || error.message).slice(0, 2000), { cause: error }))
              return
            }
            resolve(stdout.trim())
          },
        )
        child = process
        process.stdin?.end(script, "utf8")
      }),
    cancel: () => {
      child?.kill()
      child = undefined
    },
  }
}

function object(value: string) {
  if (!value) throw new Error("Windows desktop driver returned no result")
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object") throw new Error("Windows desktop driver returned invalid JSON")
  return parsed as Record<string, unknown>
}

export class WindowsDesktopDriver implements DesktopDriver {
  private readonly runner: Runner

  constructor(input?: Runner) {
    if (!input && process.platform !== "win32") throw new Error("Windows desktop control is available only on Windows")
    this.runner = input ?? runner()
  }

  async observe(): Promise<DesktopFrame> {
    const result = object(await this.runner.run(observe))
    if (
      typeof result.windowID !== "string" ||
      typeof result.location !== "string" ||
      typeof result.width !== "number" ||
      typeof result.height !== "number" ||
      result.mime !== "image/png" ||
      typeof result.data !== "string"
    )
      throw new Error("Windows desktop observation is incomplete")
    return {
      windowID: result.windowID,
      location: result.location,
      width: result.width,
      height: result.height,
      mime: result.mime,
      data: result.data,
    }
  }

  async current() {
    const result = object(await this.runner.run(current))
    if (typeof result.windowID !== "string" || typeof result.location !== "string")
      throw new Error("Windows desktop target identity is incomplete")
    return { windowID: result.windowID, location: result.location }
  }

  async perform(action: DesktopAction, target: { windowID: string; location?: string }): Promise<void> {
    await this.runner.run(perform(action, target))
  }

  cancel(): void {
    this.runner.cancel()
  }
}
