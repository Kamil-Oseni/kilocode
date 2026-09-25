import { spawn } from "node:child_process"
import { powershellCommand } from "../../util/powershell"

type Host = {
  data(listener: (value: string) => void): void
  error(listener: (error: Error) => void): void
  exit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  kill(): void
}

type Launch = (script: string) => Host

const script = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class RayaPauseHotkey {
  public delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Message {
    public IntPtr Window; public uint Value; public UIntPtr WParam; public IntPtr LParam;
    public uint Time; public Point Cursor; public uint Private;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KeyboardHook {
    public uint Key; public uint Scan; public uint Flags; public uint Time; public UIntPtr Extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MouseHook {
    public Point Cursor; public uint Data; public uint Flags; public uint Time; public UIntPtr Extra;
  }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool UnregisterHotKey(IntPtr window, int id);
  [DllImport("user32.dll")] public static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int kind, HookProc callback, IntPtr module, uint thread);
  [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);

  private static readonly HookProc KeyboardCallback = Keyboard;
  private static readonly HookProc MouseCallback = Mouse;
  private static Timer readiness;
  private static int signalled;
  private static long armed;

  public static IntPtr InstallKeyboard() { return SetWindowsHookEx(13, KeyboardCallback, IntPtr.Zero, 0); }
  public static IntPtr InstallMouse() { return SetWindowsHookEx(14, MouseCallback, IntPtr.Zero, 0); }
  public static void Arm() {
    armed = System.Diagnostics.Stopwatch.GetTimestamp() + System.Diagnostics.Stopwatch.Frequency * 3 / 4;
    readiness = new Timer(_ => {
      Console.Out.WriteLine("ready");
      Console.Out.Flush();
    }, null, 750, Timeout.Infinite);
  }
  public static void Disarm() { if (readiness != null) readiness.Dispose(); }

  private static IntPtr Keyboard(int code, IntPtr message, IntPtr data) {
    if (code >= 0) {
      var input = (KeyboardHook)Marshal.PtrToStructure(data, typeof(KeyboardHook));
      if ((input.Flags & 0x12) == 0) Manual();
    }
    return CallNextHookEx(IntPtr.Zero, code, message, data);
  }

  private static IntPtr Mouse(int code, IntPtr message, IntPtr data) {
    if (code >= 0) {
      var input = (MouseHook)Marshal.PtrToStructure(data, typeof(MouseHook));
      if ((input.Flags & 0x3) == 0) Manual();
    }
    return CallNextHookEx(IntPtr.Zero, code, message, data);
  }

  private static void Manual() {
    if (System.Diagnostics.Stopwatch.GetTimestamp() < armed || Interlocked.Exchange(ref signalled, 1) != 0) return;
    Console.Out.WriteLine("manual");
    Console.Out.Flush();
  }
}
'@
$id = 0x5241
if (-not [RayaPauseHotkey]::RegisterHotKey([IntPtr]::Zero, $id, 0x4007, 0x1B)) {
  throw "Windows refused the global Pause Raya shortcut"
}
$keyboard = [RayaPauseHotkey]::InstallKeyboard()
if ($keyboard -eq [IntPtr]::Zero) {
  [void][RayaPauseHotkey]::UnregisterHotKey([IntPtr]::Zero, $id)
  throw "Windows refused the physical keyboard takeover listener"
}
$mouse = [RayaPauseHotkey]::InstallMouse()
if ($mouse -eq [IntPtr]::Zero) {
  [void][RayaPauseHotkey]::UnhookWindowsHookEx($keyboard)
  [void][RayaPauseHotkey]::UnregisterHotKey([IntPtr]::Zero, $id)
  throw "Windows refused the physical pointer takeover listener"
}
[RayaPauseHotkey]::Arm()
try {
  $message = New-Object RayaPauseHotkey+Message
  while ([RayaPauseHotkey]::GetMessage([ref]$message, [IntPtr]::Zero, 0, 0) -gt 0) {
    if ($message.Value -eq 0x0312 -and $message.WParam.ToUInt64() -eq $id) {
      [Console]::Out.WriteLine("pause")
      [Console]::Out.Flush()
    }
  }
} finally {
  [RayaPauseHotkey]::Disarm()
  [void][RayaPauseHotkey]::UnhookWindowsHookEx($mouse)
  [void][RayaPauseHotkey]::UnhookWindowsHookEx($keyboard)
  [void][RayaPauseHotkey]::UnregisterHotKey([IntPtr]::Zero, $id)
}
`

function launch(source: string): Host {
  const child = spawn(
    powershellCommand(process.env),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::In.ReadToEnd() | Invoke-Expression"],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  )
  child.stdin.end(source, "utf8")
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  const state: { stderr: string; error?: (error: Error) => void } = { stderr: "" }
  child.stderr.on("data", (value: string) => {
    state.stderr = (state.stderr + value).slice(-4_000)
  })
  return {
    data: (listener) => child.stdout.on("data", listener),
    error: (listener) => {
      state.error = listener
      child.once("error", listener)
    },
    exit: (listener) =>
      child.once("exit", (code, signal) => {
        if (code && state.stderr) state.error?.(new Error(state.stderr))
        listener(code, signal)
      }),
    kill: () => {
      child.kill()
    },
  }
}

export class WindowsPauseHotkey {
  private readonly host: Host
  private readonly started: Promise<boolean>
  private settle!: (ready: boolean) => void
  private readonly timer: ReturnType<typeof setTimeout>
  private buffer = ""
  private disposed = false
  private failed = false
  private armed = false

  constructor(
    private readonly pause: () => void | Promise<void>,
    private readonly manual: () => void | Promise<void>,
    private readonly loss: () => void | Promise<void>,
    start: Launch = launch,
  ) {
    this.started = new Promise((resolve) => {
      this.settle = resolve
    })
    this.timer = setTimeout(() => this.fail("startup timed out"), 5_000)
    this.host = start(script)
    this.host.data((value) => this.read(value))
    this.host.error((error) => this.fail(error.message))
    this.host.exit((code, signal) => this.fail(`exit ${code ?? signal ?? "unknown"}`))
  }

  get isReady(): boolean {
    return this.armed && !this.disposed && !this.failed
  }

  ready(): Promise<boolean> {
    return this.started
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    this.settle(false)
    this.buffer = ""
    this.host.kill()
  }

  private read(value: string): void {
    if (this.disposed) return
    this.buffer = (this.buffer + value).slice(-1_024)
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line.trim() === "ready" && !this.failed) {
        this.armed = true
        clearTimeout(this.timer)
        this.settle(true)
      }
      if (line.trim() === "pause") void this.pause()
      if (line.trim() === "manual") void this.manual()
    }
  }

  private fail(detail: string): void {
    if (this.disposed || this.failed) return
    this.failed = true
    clearTimeout(this.timer)
    this.settle(false)
    console.error(`[Raya] Global Pause listener stopped: ${detail}`)
    void this.loss()
  }
}
