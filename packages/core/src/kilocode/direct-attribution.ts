import type { ChildProcess } from "node:child_process"

const entries = new WeakMap<ChildProcess, { bytes?: number; category?: string }>()
const rows: Record<string, unknown>[] = []
let attempted = 0
let dropped = 0
let failed = 0

export function begin() {
  return process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS === "1" ? { start: Date.now(), tick: performance.now() } : undefined
}

export function stderr(child: ChildProcess, value: string | Buffer) {
  const entry = entries.get(child)
  if (!entry) return
  try {
    const buffer =
      typeof value === "string" ? Buffer.from(value.slice(0, 2048)).subarray(0, 2048) : value.subarray(0, 2048)
    const text = buffer.toString("utf8").toLowerCase()
    entry.bytes = typeof value === "string" ? Buffer.byteLength(value) : value.length
    entry.category =
      text === ""
        ? "empty"
        : /not found|not running|no running instance/.test(text)
          ? "not-running"
          : /access is denied|permission denied/.test(text)
            ? "permission"
            : "unknown"
  } catch {
    ++failed
    entry.category = "diagnostic-unavailable"
  }
}

export function observe(
  child: ChildProcess,
  operation: "taskkill" | "spawn" | "shell",
  clock: ReturnType<typeof begin>,
) {
  if (!clock) return
  ++attempted
  if (attempted > 4096) {
    ++dropped
    return
  }
  const observed = Date.now()
  const elapsed = performance.now() - clock.tick
  const entry: { bytes?: number; category?: string } = {}
  entries.set(child, entry)
  const image = child.spawnfile?.split(/[\\/]/).at(-1)?.toLowerCase()
  child.once("close", (code, signal) => {
    try {
      rows.push({
        diagnosticOnly: true,
        retirementAuthority: false,
        pid: child.pid ?? null,
        parentPID: process.pid,
        start: clock.start,
        observed,
        clockStable: observed >= clock.start && Math.abs(observed - clock.start - elapsed) <= 4,
        image:
          image === "cmd.exe" || image === "cmd" ? "cmd" : image === "git.exe" || image === "git" ? "git" : "other",
        caller: operation === "taskkill" ? "cross-spawn.killGroup" : "cross-spawn.spawn",
        operation,
        code,
        signal:
          signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGINT"
            ? signal
            : signal === null
              ? null
              : "other",
        stderrBytes: entry.bytes ?? null,
        category: entry.category ?? "not-collected",
      })
    } catch {
      ++failed
    }
  })
}

export function footer() {
  return {
    diagnosticOnly: true,
    retirementAuthority: false,
    attempted,
    emitted: rows.length,
    dropped,
    failed,
    pending: attempted - dropped - failed - rows.length,
    recordsComplete: attempted === rows.length && failed === 0,
    streamContentCollected: false,
  }
}

export function records() {
  return rows
}
