import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execute = promisify(execFile)
const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RayaDesktopName {
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value, int length, ref int needed);
  public static string Name(IntPtr desktop) {
    if (desktop == IntPtr.Zero) return null;
    var value = new StringBuilder(256);
    int needed = 0;
    return GetUserObjectInformationW(desktop, 2, value, value.Capacity * 2, ref needed) ? value.ToString() : null;
  }
}
'@
$hostName = [RayaDesktopName]::Name([RayaDesktopName]::GetThreadDesktop([RayaDesktopName]::GetCurrentThreadId()))
$inputHandle = [RayaDesktopName]::OpenInputDesktop(0, $false, 1)
try { $inputName = [RayaDesktopName]::Name($inputHandle) }
finally { if ($inputHandle -ne [IntPtr]::Zero) { [void][RayaDesktopName]::CloseDesktop($inputHandle) } }
@{ host = $hostName; input = $inputName } | ConvertTo-Json -Compress
`

export async function desktopNames(): Promise<{ host?: string; input?: string }> {
  if (process.platform !== "win32") return {}
  const output = await execute(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 8_000, maxBuffer: 8_192 },
  )
  const value = JSON.parse(output.stdout) as Record<string, unknown>
  return {
    host: typeof value.host === "string" ? value.host : undefined,
    input: typeof value.input === "string" ? value.input : undefined,
  }
}
