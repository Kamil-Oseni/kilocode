import { spawn } from "node:child_process"
import path from "node:path"
import { createInterface } from "node:readline"
import z from "zod"

const script = `using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RayaSourceHandle {
[DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint rights,bool inherit,uint pid);
[DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long born,out long exit,out long kernel,out long user);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder text,ref uint size);
[DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint timeout);
[DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
public static void Watch(uint pid,long expected,string executable,uint timeout) {
var h=OpenProcess(0x101000,false,pid);
if(h==IntPtr.Zero) throw new InvalidOperationException("Source helper native handle unavailable");
try { long born,exit,kernel,user;
if(!GetProcessTimes(h,out born,out exit,out kernel,out user)||born!=expected) throw new InvalidOperationException("Source helper birth changed");
var text=new StringBuilder(32768); uint size=32768;
if(!QueryFullProcessImageName(h,0,text,ref size)||!String.Equals(text.ToString(),executable,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Source helper image changed");
Console.WriteLine("{\\"phase\\":\\"ready\\"}"); Console.Out.Flush();
if(WaitForSingleObject(h,timeout)!=0) throw new InvalidOperationException("Source family native retirement timed out");
uint code;
if(!GetExitCodeProcess(h,out code)||code==259) throw new InvalidOperationException("Source helper exact exit unavailable");
Console.WriteLine("{\\"phase\\":\\"exit\\",\\"code\\":"+code+"}"); Console.Out.Flush();
} finally { CloseHandle(h); }
}}
`

/** The observer holds the original kernel handle; it never terminates the observed family. */
export function observe(input: { pid: number; birth: string; executable: string; timeout: number }) {
  if (
    process.platform !== "win32" ||
    !Number.isSafeInteger(input.pid) ||
    input.pid <= 0 ||
    input.pid > 0xffffffff ||
    !/^\d{1,20}$/.test(input.birth) ||
    BigInt(input.birth) <= 0n ||
    BigInt(input.birth) > 0x7fffffffffffffffn ||
    !path.isAbsolute(input.executable) ||
    !Number.isSafeInteger(input.timeout) ||
    input.timeout < 100 ||
    input.timeout > 60000
  )
    throw new Error("Source helper observer identity invalid")
  const executable = input.executable.replaceAll("'", "''")
  const command = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${script}\n'@; [RayaSourceHandle]::Watch(${input.pid},[long]${input.birth},'${executable}',${input.timeout})`
  const shell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  const child = spawn(
    shell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  )
  const state = {
    ready: false,
    code: undefined as number | undefined,
    error: undefined as Error | undefined,
    size: 0,
    stderr: "",
  }
  let resolve: () => void
  let reject: (err: Error) => void
  const ready = new Promise<void>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  void ready.catch(() => undefined)
  const lines = createInterface({ input: child.stdout })
  const failure = (err: Error) => {
    state.error ??= err
    reject(err)
    child.kill()
  }
  const timer = setTimeout(() => failure(new Error("Source helper observer did not acquire its native handle")), 15000)
  lines.on("line", (line) => {
    state.size += Buffer.byteLength(line)
    if (state.size > 4096) return failure(new Error("Source helper observer output exceeded bound"))
    try {
      const value: unknown = JSON.parse(line)
      if (!state.ready) {
        z.object({ phase: z.literal("ready") })
          .strict()
          .parse(value)
        state.ready = true
        clearTimeout(timer)
        resolve()
        return
      }
      if (state.code !== undefined) throw new Error("Duplicate source helper retirement response")
      state.code = z
        .object({ phase: z.literal("exit"), code: z.number().int().nonnegative().max(0xffffffff) })
        .strict()
        .parse(value).code
    } catch (err) {
      failure(err instanceof Error ? err : new Error("Source helper observer response invalid"))
    }
  })
  child.stderr.on("data", (data: Buffer) => {
    state.stderr = (state.stderr + data.toString()).slice(0, 4096)
  })
  const done = new Promise<number>((ok, fail) => {
    child.once("error", (err) => {
      failure(err)
      fail(err)
    })
    child.once("close", (code, signal) => {
      clearTimeout(timer)
      lines.close()
      if (state.error || code !== 0 || signal || !state.ready || state.code === undefined) {
        const err = state.error ?? new Error(`Source helper native observer refused retirement: ${state.stderr}`)
        reject(err)
        fail(err)
        return
      }
      ok(state.code)
    })
  })
  void done.catch(() => undefined)
  return {
    ready,
    done,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null)
        failure(new Error("Source helper observer cancelled; retirement remains unconfirmed"))
      await done.catch(() => undefined)
    },
  }
}
