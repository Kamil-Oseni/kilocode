import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { resolve } from "@opencode-ai/core/kilocode/database-path"
import { Process } from "@/util/process"
import { PowerShell, pwsh } from "@/kilocode/shell/shell"
import * as Windows from "@/kilocode/background-process/windows-tree"
import { decode, refused, type ImagePhase } from "./image-diagnostic"

export const Certificate = z.object({
  version: z.literal(1),
  generation: z.string().uuid(),
  birth: z.string().regex(/^\d{1,20}$/),
  executable: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  roots: z.record(z.string(), z.string()),
  request: z.string(),
  receipt: z.string(),
})
export type Certificate = z.infer<typeof Certificate>

/** Resolve existing ancestors without creating unused profile directories. */
export async function canonical(file: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error("Daemon root must be absolute")
  const result = await realpath(file).catch(async (err: unknown) => {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err
    const parent = path.dirname(file)
    if (parent === file) throw err
    return path.join(await canonical(parent), path.basename(file))
  })
  return process.platform === "win32" ? path.normalize(result).toLowerCase() : path.normalize(result)
}

export async function roots(env: NodeJS.ProcessEnv, state: string, log: string) {
  const home = env.KILO_TEST_HOME ?? env.USERPROFILE ?? env.HOME ?? Global.Path.home
  const data = path.join(env.XDG_DATA_HOME ?? path.dirname(Global.Path.data), "kilo")
  const values = {
    home,
    data,
    config: path.join(env.XDG_CONFIG_HOME ?? path.dirname(Global.Path.config), "kilo"),
    cache: path.join(env.XDG_CACHE_HOME ?? path.dirname(Global.Path.cache), "kilo"),
    state: path.join(env.XDG_STATE_HOME ?? path.dirname(Global.Path.state), "kilo"),
    log: path.join(data, "log"),
    database: resolve({
      data,
      channel: InstallationChannel,
      disabled: (env.RAYA_DISABLE_CHANNEL_DB ?? env.KILO_DISABLE_CHANNEL_DB) === "1",
      override: env.RAYA_DB ?? env.KILO_DB,
    }),
    controller: state,
    output: log,
  }
  if (values.database === ":memory:") throw new Error("Daemon ownership requires a persistent database root")
  return Object.fromEntries(
    await Promise.all(Object.entries(values).map(async ([kind, file]) => [kind, await canonical(file)])),
  )
}

const source = `using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RayaDaemonImage {
[DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
[DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long born, out long exit, out long kernel, out long user);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder text, ref uint size);
[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
public static string[] Read(uint pid) {
var h=OpenProcess(0x1000, false, pid);
if(h==IntPtr.Zero) throw new InvalidOperationException("Process image unavailable");
try { long born,exit,kernel,user; if(!GetProcessTimes(h,out born,out exit,out kernel,out user)) throw new InvalidOperationException("Process birth unavailable");
var text=new StringBuilder(32768); uint size=32768;
if(!QueryFullProcessImageName(h,0,text,ref size)) throw new InvalidOperationException("Process image unavailable");
return new[]{born.ToString(System.Globalization.CultureInfo.InvariantCulture),text.ToString()};
} finally { CloseHandle(h); }
}}
`

export async function image(pid: number) {
  if (process.platform !== "win32") throw new Error("Exact daemon ownership currently requires Windows")
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error("Invalid daemon PID")
  let phase: ImagePhase = "probe"
  try {
    const shell = pwsh()
    if (!shell) throw new Error("Windows process image host unavailable")
    const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${source}\n'@\nConvertTo-Json -InputObject @([RayaDaemonImage]::Read(${pid})) -Compress`
    const output = await Process.text([shell, ...PowerShell.args(script)], {
      nothrow: true,
      abort: AbortSignal.timeout(15000),
      timeout: 2000,
    })
    if (output.code !== 0) throw new Error("Daemon process image could not be verified")
    phase = "frame"
    const [birth, file] = decode(output.text)
    phase = "path"
    const executable = await canonical(file)
    phase = "bytes"
    const before = await stat(file)
    const digest = createHash("sha256")
      .update(
        await Bun.file(file)
          .arrayBuffer()
          .then((buffer) => Buffer.from(buffer)),
      )
      .digest("hex")
    const after = await stat(file)
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Daemon executable changed during verification")
    phase = "current-birth"
    const current = await Windows.sample(pid)
    if (current.status !== "owned" || current.birth !== birth)
      throw new Error("Daemon process changed during verification")
    return { birth, executable, digest }
  } catch (err) {
    throw refused(err, phase)
  }
}

export async function verify(pid: number, certificate: Certificate) {
  for (const [kind, file] of [
    ["request", certificate.request],
    ["receipt", certificate.receipt],
  ] as const) {
    if (
      path.basename(file) !== `daemon-${certificate.generation}.${kind}.json` ||
      (await canonical(path.dirname(file))) !== certificate.roots.controller
    )
      throw new Error("Daemon control path changed; process preserved")
  }
  const current = await image(pid)
  if (
    current.birth !== certificate.birth ||
    current.executable !== certificate.executable ||
    current.digest !== certificate.digest
  )
    throw new Error("Daemon ownership changed; process preserved")
  for (const file of Object.values(certificate.roots))
    if ((await canonical(file)) !== file) throw new Error("Daemon canonical root changed; process preserved")
  return current
}
