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

const acquired: number[] = []
const prepared: number[] = []
const observed: number[] = []
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
    }
    await Bun.sleep(5)
  }
  const memory = process.memoryUsage()
  console.log(
    JSON.stringify(
      {
        format: "raya.computer-use-native-benchmark",
        version: 2,
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
        elapsedMs: Number((performance.now() - started).toFixed(2)),
        hostMemoryBytes: { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external },
        note: "No pixels are saved. Host memory excludes the native child; this does not measure model or action-to-frame latency.",
      },
      undefined,
      2,
    ),
  )
  if (failure || observed.length < count) process.exitCode = 2
} finally {
  host.stop()
}
