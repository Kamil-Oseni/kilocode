import { NativeProcess } from "./process-host"
import { spawnSync } from "node:child_process"
import path from "node:path"

let identity: string | undefined
const valid = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,20}$/.test(value) && BigInt(value) > 0n && BigInt(value) <= 0xffffffffffffffffn

/** Bundled Node adapters have no CLI helper: query the same kernel creation time through their held Process handle. */
function node(pid: number): unknown {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff || !process.env.SystemRoot)
    throw new Error("Profile native process identity is unavailable")
  const script = `$ErrorActionPreference='Stop';$p=$null;try{try{$p=[Diagnostics.Process]::GetProcessById(${pid})}catch [ArgumentException]{'{"status":"gone","birth":null}';return};$null=$p.Handle;$birth=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();$status=if($p.HasExited){'gone'}else{'owned'};@{status=$status;birth=$birth}|ConvertTo-Json -Compress}catch{'{"status":"unknown","birth":null}'}finally{if($null -ne $p){$p.Dispose()}}`
  const file = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const started = performance.now()
  const child = spawnSync(file, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4096,
    timeout: 15_000,
  })
  if (
    child.error ||
    child.status !== 0 ||
    child.signal ||
    !child.stdout ||
    !child.stderr ||
    performance.now() - started >= 15_000
  )
    throw new Error("Profile native process identity is unavailable", { cause: child.error })
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(child.stdout)) as unknown
}

const supported = () => process.platform === "win32" && process.arch === "x64"
const native = () => !!process.versions.bun

/** Legacy platforms retain their conservative PID-only records; native Windows records bind creation time. */
export function birth() {
  if (!supported() || (native() && NativeProcess.mode() !== "native")) return undefined
  if (identity) return identity
  const value = native() ? NativeProcess.inspectSync(process.pid) : node(process.pid)
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    value.status !== "owned" ||
    !("birth" in value) ||
    !valid(value.birth)
  )
    throw new Error("Profile native process identity is unavailable")
  identity = value.birth
  return identity
}

/** An exact birth mismatch proves the recorded owner is gone; unavailable identity never permits reclamation. */
export async function retired(pid: number, birth: unknown) {
  if (!valid(birth) || !supported() || (native() && NativeProcess.mode() !== "native"))
    throw new Error("Profile native ownership is uncertain")
  const value = native() ? await NativeProcess.inspect(pid) : node(pid)
  if (!value || typeof value !== "object" || !("status" in value) || !("birth" in value))
    throw new Error("Profile native ownership is uncertain")
  if (value.status === "gone") return true
  if (value.status !== "owned" || !valid(value.birth)) return false
  return value.birth !== birth
}
