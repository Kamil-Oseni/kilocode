import z from "zod"
import { PowerShell, pwsh } from "@/kilocode/shell/shell"

const source = `using System;
using System.Runtime.InteropServices;
public static class RayaDaemonExit {
[DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights,bool inherit,uint pid);
[DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long born,out long exit,out long kernel,out long user);
[DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
[DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint timeout);
[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
public static void Wait(uint pid,string expected,uint timeout) {
var h=OpenProcess(0x101000,false,pid);
if(h==IntPtr.Zero) throw new InvalidOperationException("Daemon exit handle unavailable");
try { long born,exit,kernel,user; if(!GetProcessTimes(h,out born,out exit,out kernel,out user)||born.ToString(System.Globalization.CultureInfo.InvariantCulture)!=expected) throw new InvalidOperationException("Daemon exit identity changed");
Console.WriteLine("READY"); Console.Out.Flush();
if(WaitForSingleObject(h,timeout)!=0) throw new InvalidOperationException("Daemon exit not confirmed before deadline");
uint code; if(!GetExitCodeProcess(h,out code)) throw new InvalidOperationException("Daemon exit code unavailable");
var q=(char)34; Console.WriteLine("{"+q+"version"+q+":1,"+q+"birth"+q+":"+q+expected+q+","+q+"code"+q+":"+code.ToString()+"}"); Console.Out.Flush();
} finally {CloseHandle(h);}
}}
`

/** Hold the exact kernel process handle before issuing the cooperative request. */
export async function watch(pid: number, birth: string, timeout: number) {
  if (
    process.platform !== "win32" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !/^\d{1,20}$/.test(birth) ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > 60000
  )
    throw new Error("Invalid daemon exit observation")
  const shell = pwsh()
  if (!shell) throw new Error("Daemon exit observer unavailable")
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${source}\n'@\n[RayaDaemonExit]::Wait(${pid}, '${birth}', ${timeout})`
  const child = Bun.spawn([shell, ...PowerShell.args(script)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const ready = Promise.withResolvers<void>()
  const stderr = new Response(child.stderr).text()
  const output = (async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    const parts: string[] = []
    while (true) {
      const next = await reader.read()
      if (next.done) break
      parts.push(decoder.decode(next.value, { stream: true }))
      const text = parts.join("")
      if (text.length > 8192) throw new Error("Daemon exit observer output exceeded bound")
      if (text.startsWith("READY\r\n") || text.startsWith("READY\n")) ready.resolve()
    }
    return parts.join("") + decoder.decode()
  })()
  const done = Promise.all([child.exited, output, stderr]).then(([code, text, error]) => {
    if (code !== 0) throw new Error(`Daemon exit observer failed: ${error.slice(0, 512)}`)
    const receipt = z
      .object({ version: z.literal(1), birth: z.literal(birth), code: z.number().int().nonnegative() })
      .strict()
      .parse(JSON.parse(text.split(/\r?\n/).filter(Boolean).at(-1)!))
    return { ...receipt, pid }
  })
  void done.catch(ready.reject)
  await ready.promise
  return {
    done,
    async close() {
      if (child.exitCode === null) child.kill("SIGKILL")
      await Promise.allSettled([done])
    },
  }
}
