import { Schema } from "effect"
import { PowerShell, pwsh } from "@/kilocode/shell/shell"
import { Process } from "@/util/process"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"

const source = `
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
public static class RayaProcess {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Entry {
    public uint size, usage, pid;
    public UIntPtr heap;
    public uint module, threads, parent;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
  }
  public sealed class Row { public uint pid, parent; public string birth; }
  [StructLayout(LayoutKind.Sequential)]
  private struct Basic {
    public int exit;
    public IntPtr peb;
    public UIntPtr affinity;
    public int priority;
    public UIntPtr pid, parent;
  }
  public sealed class Result { public string status, birth; public uint parent; }
  [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr handle, uint kind, out Basic value, uint size, out uint length);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr handle, out long birth, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32FirstW(IntPtr handle, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32NextW(IntPtr handle, ref Entry entry);
  public static Result Inspect(uint pid, string expected, bool stop) {
    IntPtr handle = OpenProcess(0x101400u | (stop ? 1u : 0u), false, pid);
    if (handle == IntPtr.Zero)
      return new Result { status = Marshal.GetLastWin32Error() == 87 ? "gone" : "unknown" };
    try {
      long birth, exit, kernel, user;
      if (!GetProcessTimes(handle, out birth, out exit, out kernel, out user))
        return new Result { status = "unknown" };
      string identity = birth.ToString(CultureInfo.InvariantCulture);
      if (!String.IsNullOrEmpty(expected) && expected != identity) return new Result { status = "foreign", birth = identity };
      uint state = WaitForSingleObject(handle, 0);
      if (state == 0) return new Result { status = "gone", birth = identity };
      if (state != 258) return new Result { status = "unknown", birth = identity };
      if (!stop) {
        Basic basic;
        uint length;
        uint size = (uint)Marshal.SizeOf(typeof(Basic));
        if (NtQueryInformationProcess(handle, 0, out basic, size, out length) != 0 || length != size ||
            basic.pid.ToUInt64() != pid || basic.parent.ToUInt64() > UInt32.MaxValue)
          return new Result { status = "unknown" };
        return new Result { status = "owned", birth = identity, parent = (uint)basic.parent.ToUInt64() };
      }
      if (!TerminateProcess(handle, 1) && WaitForSingleObject(handle, 0) != 0)
        return new Result { status = "unknown", birth = identity };
      return new Result { status = WaitForSingleObject(handle, 2000) == 0 ? "confirmed" : "unknown", birth = identity };
    } finally { CloseHandle(handle); }
  }
  public static Row[] Query() {
    IntPtr handle = CreateToolhelp32Snapshot(2, 0);
    if (handle == new IntPtr(-1)) throw new InvalidOperationException("Process snapshot unavailable");
    try {
      Entry entry = new Entry { size = (uint)Marshal.SizeOf(typeof(Entry)) };
      List<Row> rows = new List<Row>();
      bool found = Process32FirstW(handle, ref entry);
      while (found) {
        if (rows.Count >= 32768) throw new InvalidOperationException("Process snapshot exceeded its bound");
        Result result = entry.pid == 0 ? new Result { status = "unknown" } : Inspect(entry.pid, null, false);
        rows.Add(new Row { pid = entry.pid, parent = result.status == "owned" ? result.parent : entry.parent,
          birth = result.status == "owned" ? result.birth : null });
        found = Process32NextW(handle, ref entry);
      }
      if (Marshal.GetLastWin32Error() != 18) throw new InvalidOperationException("Process snapshot was incomplete");
      return rows.ToArray();
    } finally { CloseHandle(handle); }
  }
}
`
const Result = Schema.Struct({
  status: Schema.Literals(["owned", "gone", "foreign", "confirmed", "unknown"]),
  birth: Schema.NullOr(Schema.String),
})
const Rows = Schema.Array(
  Schema.Struct({ pid: Schema.Number, parent: Schema.Number, birth: Schema.NullOr(Schema.String) }),
)
const decode = Schema.decodeUnknownSync(Result)

async function call(command: string) {
  if (process.platform !== "win32") throw new Error("Windows process ownership is unavailable")
  const shell = pwsh()
  if (!shell) throw new Error("Windows process ownership host is unavailable")
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${source}\n'@\n${command}`
  const result = await Process.text([shell, ...PowerShell.args(script)], {
    nothrow: true,
    abort: AbortSignal.timeout(15000),
    timeout: 2000,
  })
  if (result.code !== 0 || result.text.length > 8 * 1024 * 1024)
    throw new Error("Windows process ownership could not be verified")
  return JSON.parse(result.text) as unknown
}

function id(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error("Invalid process identity")
  return pid
}

/** Birth and termination use the same kernel handle, so PID reuse cannot redirect termination. */
export async function terminate(pid: number, birth: string) {
  if (!/^\d{1,20}$/.test(birth)) throw new Error("Invalid process birth identity")
  if (NativeProcess.mode() === "native") return decode(await NativeProcess.terminate(id(pid), birth)).status
  return decode(await call(`[RayaProcess]::Inspect(${id(pid)}, '${birth}', $true) | ConvertTo-Json -Compress`)).status
}

export async function sample(pid: number) {
  if (NativeProcess.mode() === "native") return decode(await NativeProcess.inspect(id(pid)))
  return decode(await call(`[RayaProcess]::Inspect(${id(pid)}, $null, $false) | ConvertTo-Json -Compress`))
}

/** Unknown births remain in the tree; callers must refuse when a relevant owner is unreadable. */
export async function query() {
  const rows = Schema.decodeUnknownSync(Rows)(
    NativeProcess.mode() === "native"
      ? await NativeProcess.query()
      : await call("ConvertTo-Json -InputObject @([RayaProcess]::Query()) -Compress"),
  )
  if (rows.length > 32768 || rows.some((row) => !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.parent)))
    throw new Error("Invalid process snapshot")
  return rows
}
