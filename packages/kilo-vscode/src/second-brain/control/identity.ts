import { lstat, realpath, open as file } from "node:fs/promises"
import path from "node:path"
import type { ChildProcess } from "node:child_process"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { command as execute } from "./command"
import { check, sha } from "./frames"
export const normalize = (value: string) => path.resolve(value).replace(/\\/g, "/").toLowerCase()
export async function image(name: string, limit = 1048576) {
  const before = await lstat(name, { bigint: true })
  check(
    before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(limit),
    "Bounded single-link image required",
  )
  const held = await file(name, "r")
  const result = await (async () => {
    const initial = await held.stat({ bigint: true })
    const buffer = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < buffer.length) {
      const next = await held.read(buffer, offset, buffer.length - offset, offset)
      if (!next.bytesRead) break
      offset += next.bytesRead
    }
    check(offset <= limit, "Image read exceeded bound")
    const raw = buffer.subarray(0, offset)
    const final = await held.stat({ bigint: true })
    const after = await lstat(name, { bigint: true })
    const tuple = (value: typeof before) =>
      [value.dev, value.ino, value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(":")
    check(
      [initial, final, after].every((value) => tuple(value) === tuple(before)) && raw.length === Number(before.size),
      "Image changed during read",
    )
    return { raw, digest: sha(raw), tuple: tuple(before) }
  })().then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err }),
  )
  const closed = await held.close().then(
    () => ({ ok: true as const }),
    (err: unknown) => ({ ok: false as const, err }),
  )
  if (!result.ok)
    throw closed.ok ? result.err : new AggregateError([result.err, closed.err], "Image and close failures retained")
  if (!closed.ok) throw closed.err
  return result.value
}
export async function directory(name: string) {
  check(path.isAbsolute(name), "Absolute root required")
  const canonical = await realpath(name)
  check(normalize(canonical) === normalize(name), "Canonical root required")
  const parts = []
  for (let node = path.resolve(name); ; node = path.dirname(node)) {
    parts.push(node)
    if (node === path.dirname(node)) break
  }
  for (const node of parts) {
    const row = await lstat(node)
    check(row.isDirectory() && !row.isSymbolicLink(), "Ordinary directory ancestry required")
  }
  return canonical
}

export type Identity = Readonly<{ pid: number; birth: string; parent: number; executable: string; digest: string }>
const identities = new WeakMap<Identity, ChildProcess>()
export const valid = (identity: Identity, child: ChildProcess) => identities.get(identity) === child

export function powershell() {
  check(process.platform === "win32" && process.env.SystemRoot, "Windows control host required")
  return path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

export function environment() {
  const exe = powershell()
  return {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: path.join(process.env.SystemRoot!, "System32"),
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PSModulePath: path.join(path.dirname(exe), "Modules"),
  }
}

/** Observation belongs to this actual held child; it is not a lifetime supervisor. */
export async function observe(child: ChildProcess, python: string, helper: string, digest: string): Promise<Identity> {
  check(child.pid, "Actual child PID required")
  const native = await NativeProcess.inspect(child.pid, helper)
  check(
    native &&
      typeof native === "object" &&
      "status" in native &&
      native.status === "owned" &&
      "birth" in native &&
      typeof native.birth === "string" &&
      "parent" in native &&
      native.parent === process.pid,
    "Actual birth/parent refused",
  )
  const command = `$row=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}'; if(!$row){throw 'Owned child absent'}; [ordered]@{pid=[int]$row.ProcessId;parent=[int]$row.ParentProcessId;exe=[string]$row.ExecutablePath}|ConvertTo-Json -Compress`
  const output = await execute(
    powershell(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ],
    { windowsHide: true, env: environment() },
  )
  const actual = JSON.parse(output.stdout) as { pid: number; parent: number; exe: string }
  check(
    actual.pid === child.pid &&
      actual.parent === process.pid &&
      typeof actual.exe === "string" &&
      normalize(actual.exe) === normalize(python),
    "Actual child image refused",
  )
  const identity = Object.freeze({
    pid: child.pid,
    birth: native.birth,
    parent: process.pid,
    executable: actual.exe,
    digest,
  })
  identities.set(identity, child)
  return identity
}
