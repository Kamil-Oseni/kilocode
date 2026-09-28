import { spawn, type ChildProcess } from "node:child_process"
import { PowerShell } from "@/kilocode/shell/shell"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"

const source = `
using System;
using System.IO;
using System.Globalization;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class RayaJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long processTime, jobTime;
    public uint flags;
    public UIntPtr minimum, maximum;
    public uint processes;
    public UIntPtr affinity;
    public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters {
    public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public Basic basic;
    public Counters io;
    public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user, kernel, periodUser, periodKernel;
    public uint faults, total, active, terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, uint kind, ref Limits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, uint kind, out Accounting accounting, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static IntPtr Pin(uint pid, string expected, uint access) {
    IntPtr handle = OpenProcess(access, false, pid);
    if (handle == IntPtr.Zero) throw new InvalidOperationException("Native process owner could not be pinned");
    long birth, exit, kernel, user;
    if (!GetProcessTimes(handle, out birth, out exit, out kernel, out user) || birth.ToString(CultureInfo.InvariantCulture) != expected) {
      CloseHandle(handle);
      throw new InvalidOperationException("Native process owner identity changed");
    }
    return handle;
  }
  static void Write(string file, string value) {
    string temp = file + ".tmp";
    File.WriteAllText(temp, value);
    if (File.Exists(file)) File.Delete(file);
    File.Move(temp, file);
  }
  public static void Run(uint pid, string birth, uint controller, string parentBirth, string control, string token) {
    IntPtr job = IntPtr.Zero, process = IntPtr.Zero, parent = IntPtr.Zero;
    try {
      process = Pin(pid, birth, 0x101501);
      parent = Pin(controller, parentBirth, 0x101400);
      job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new InvalidOperationException("Native job containment is unavailable");
      Limits limits = new Limits();
      limits.basic.flags = 0x2000;
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))))
        throw new InvalidOperationException("Native job containment could not be configured");
      if (!AssignProcessToJobObject(job, process))
        throw new InvalidOperationException("Native process could not be contained");
      Write(control + ".job", "{\\"version\\":2,\\"token\\":\\"" + token + "\\",\\"proof\\":\\"windows-job\\",\\"assigned\\":true}");
      bool stopping = false;
      Stopwatch deadline = null;
      while (true) {
        Accounting state;
        if (!QueryInformationJobObject(job, 1, out state, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
          throw new InvalidOperationException("Native job activity could not be verified");
        if (state.active == 0) {
          Write(control + ".drained", "{\\"version\\":2,\\"token\\":\\"" + token + "\\",\\"proof\\":\\"windows-job\\",\\"empty\\":true}");
          return;
        }
        uint parentState = WaitForSingleObject(parent, 0);
        if (parentState != 0 && parentState != 258)
          throw new InvalidOperationException("Native controller liveness could not be verified");
        if (!stopping && (File.Exists(control) || parentState == 0)) {
          if (!TerminateJobObject(job, 1)) throw new InvalidOperationException("Native job termination could not be confirmed");
          stopping = true;
          deadline = Stopwatch.StartNew();
        }
        if (deadline != null && deadline.ElapsedMilliseconds >= 60000) throw new InvalidOperationException("Native job termination did not drain");
        Thread.Sleep(50);
      }
    } finally {
      if (job != IntPtr.Zero) CloseHandle(job);
      if (parent != IntPtr.Zero) CloseHandle(parent);
      if (process != IntPtr.Zero) CloseHandle(process);
    }
  }
}
`
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

/** A retained native job handle contains descendants before the shell opens its private command gate. */
export async function guardian(input: {
  pid: number
  birth: string
  controller: number
  parentBirth: string
  control: string
  token: string
}): Promise<ChildProcess> {
  if (NativeProcess.mode() === "native") return NativeProcess.guard(input)
  if (
    ![input.pid, input.controller].every((pid) => Number.isSafeInteger(pid) && pid > 0) ||
    ![input.birth, input.parentBirth].every((birth) => /^\d{1,20}$/.test(birth)) ||
    !/^[a-f0-9-]{36}$/.test(input.token)
  )
    throw new Error("Invalid native job owner")
  const script = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition ${quote(source)}; [RayaJob]::Run(${input.pid}, ${quote(input.birth)}, ${input.controller}, ${quote(input.parentBirth)}, ${quote(input.control)}, ${quote(input.token)})`
  return spawn(
    PowerShell.pwsh() ?? "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  )
}
