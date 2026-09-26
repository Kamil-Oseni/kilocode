import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { NativeCaptureHost } from "../src/services/computer-use/desktop-native-host"

const binary = Bun.argv[2]
const count = Number(Bun.argv[3] ?? 40)
const timeout = Number(Bun.argv[4] ?? 30_000)
if (!binary) throw new Error("Pass the compiled native capture host path")
if (!Number.isInteger(count) || count < 1 || count > 1_000) throw new Error("Choose 1 to 1000 native frames")
if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000)
  throw new Error("Choose a 1,000 to 300,000 ms native capture timeout")

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(2))
}

function summary(values: number[]) {
  if (!values.length) return
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
}

const execute = promisify(execFile)

async function sample(pid: number, frame: number, at: number) {
  const cmd = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write("$($p.WorkingSet64),$($p.PrivateMemorySize64),$($p.Handles)")`
  try {
    const result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 4_096,
    })
    const match = /^(\d+),(\d+),(\d+)$/.exec(result.stdout.trim())
    if (!match) return { frame, atMs: Number(at.toFixed(2)), status: "unavailable" as const }
    return {
      frame,
      atMs: Number(at.toFixed(2)),
      workingSetBytes: Number(match[1]),
      privateBytes: Number(match[2]),
      handles: Number(match[3]),
    }
  } catch {
    return { frame, atMs: Number(at.toFixed(2)), status: "unavailable" as const }
  }
}

const acquired: number[] = []
const prepared: number[] = []
const observed: number[] = []
const samples: Array<ReturnType<typeof sample>> = []
let failure: Error | undefined
let sequence = 0
let gaps = 0
const started = performance.now()
const host = new NativeCaptureHost(binary, (error) => {
  failure = error
})
try {
  host.start()
  while (observed.length < count && performance.now() - started < timeout && !failure) {
    const frame = host.latest(1_000, sequence)
    if (frame && frame.sequence > sequence) {
      if (sequence) gaps += Math.max(0, frame.sequence - sequence - 1)
      sequence = frame.sequence
      acquired.push(frame.acquisitionMs)
      prepared.push(frame.preparationMs)
      observed.push(performance.now() - started)
      if (observed.length === 1 || observed.length % 200 === 0) {
        const pid = host.pid()
        if (pid) samples.push(sample(pid, observed.length, performance.now() - started))
      }
    }
    await Bun.sleep(5)
  }
  const memory = process.memoryUsage()
  const elapsed = Number((performance.now() - started).toFixed(2))
  const native = await Promise.all(samples)
  console.log(
    JSON.stringify(
      {
        format: "raya.computer-use-native-benchmark",
        version: 3,
        mode: "local-native-source-host",
        status: failure
          ? "unavailable"
          : observed.length >= count
            ? "complete"
            : observed.length
              ? "partial"
              : "no_frames",
        ...(failure ? { reason: failure.message } : {}),
        requestedFrames: count,
        timeoutMs: timeout,
        frames: observed.length,
        skippedSequences: gaps,
        timeToFirstFrameMs: observed.length ? Number(observed[0].toFixed(2)) : undefined,
        acquisitionMs: summary(acquired),
        preparationMs: summary(prepared),
        elapsedMs: elapsed,
        hostMemoryBytes: { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external },
        nativeMemorySamples: native,
        nativeMemoryStatus: native.length && native.every((item) => !("status" in item)) ? "complete" : "partial",
        note: "No pixels are saved. Native memory samples are bounded point observations; this does not measure model or action-to-frame latency.",
      },
      undefined,
      2,
    ),
  )
  if (failure || observed.length < count) process.exitCode = 2
} finally {
  host.stop()
}
