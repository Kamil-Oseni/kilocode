import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { hostname } from "node:os"

const cache: { done: boolean; value?: string } = { done: false }

function birth(pid: number) {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8")
      const end = raw.lastIndexOf(")")
      if (end < 0) return
      const fields = raw
        .slice(end + 2)
        .trim()
        .split(/\s+/)
      const ticks = fields[19]
      if (!ticks || !/^\d+$/.test(ticks)) return
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
      if (!/^[a-f0-9-]{36}$/i.test(boot)) return
      return `${boot}:${ticks}`
    } catch {
      return
    }
  }
  if (process.platform !== "win32") return
  const query = `[Console]::Out.Write((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O',[Globalization.CultureInfo]::InvariantCulture))`
  const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4_096,
    windowsHide: true,
  })
  const value = out.stdout?.trim()
  if (out.error || out.status !== 0 || !value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/.test(value)) return
  return value
}

function current() {
  if (!cache.done) {
    cache.value = birth(process.pid)
    cache.done = true
  }
  return cache.value
}

export function owner() {
  return { host: hostname(), pid: process.pid }
}

/** Capture OS creation identity only for durable work that needs PID-reuse detection. */
export function durable() {
  const value = current()
  return { host: hostname(), pid: process.pid, ...(value ? { birth: value } : {}) }
}

/** ESRCH or a different OS birth proves the recorded process stopped; failed probes remain uncertain. */
export function stopped(value: unknown) {
  if (!value || typeof value !== "object" || !("host" in value) || !("pid" in value)) return false
  if (value.host !== hostname() || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0)
    return false
  try {
    process.kill(value.pid, 0)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return true
  }
  if (!("birth" in value) || typeof value.birth !== "string" || !value.birth) return false
  const observed = value.pid === process.pid ? current() : birth(value.pid)
  return !!observed && observed !== value.birth
}
