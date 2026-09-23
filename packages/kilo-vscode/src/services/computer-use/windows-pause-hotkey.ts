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

public static class RayaPauseHotkey {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Message {
    public IntPtr Window; public uint Value; public UIntPtr WParam; public IntPtr LParam;
    public uint Time; public Point Cursor; public uint Private;
  }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool UnregisterHotKey(IntPtr window, int id);
  [DllImport("user32.dll")] public static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
}
'@
$id = 0x52415941
if (-not [RayaPauseHotkey]::RegisterHotKey([IntPtr]::Zero, $id, 0x4007, 0x1B)) {
  throw "Windows refused the global Pause Raya shortcut"
}
try {
  $message = New-Object RayaPauseHotkey+Message
  while ([RayaPauseHotkey]::GetMessage([ref]$message, [IntPtr]::Zero, 0, 0) -gt 0) {
    if ($message.Value -eq 0x0312 -and $message.WParam.ToUInt64() -eq $id) {
      [Console]::Out.WriteLine("pause")
      [Console]::Out.Flush()
    }
  }
} finally {
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
  return {
    data: (listener) => child.stdout.on("data", listener),
    error: (listener) => child.once("error", listener),
    exit: (listener) => child.once("exit", listener),
    kill: () => {
      child.kill()
    },
  }
}

export class WindowsPauseHotkey {
  private readonly host: Host
  private buffer = ""
  private disposed = false
  private failed = false

  constructor(
    private readonly pause: () => void | Promise<void>,
    private readonly loss: () => void | Promise<void>,
    start: Launch = launch,
  ) {
    this.host = start(script)
    this.host.data((value) => this.read(value))
    this.host.error((error) => this.fail(error.message))
    this.host.exit((code, signal) => this.fail(`exit ${code ?? signal ?? "unknown"}`))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.buffer = ""
    this.host.kill()
  }

  private read(value: string): void {
    if (this.disposed) return
    this.buffer = (this.buffer + value).slice(-1_024)
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ""
    for (const line of lines) if (line.trim() === "pause") void this.pause()
  }

  private fail(detail: string): void {
    if (this.disposed || this.failed) return
    this.failed = true
    console.error(`[Raya] Global Pause listener stopped: ${detail}`)
    void this.loss()
  }
}
