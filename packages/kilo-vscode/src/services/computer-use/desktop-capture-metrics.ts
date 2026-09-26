// In-memory numeric capture measurements from an active installed host.
// A probe duration is optional because DesktopFrame does not measure one.
import type { DesktopCaptureWorker } from "./desktop-capture-worker"
const LIMIT = 240
const WINDOW_MS = 60_000
const MAX_MS = 120_000

type Sample = {
  age: number
  interval?: number
  acquisition: number
  preparation: number
  probe?: number
}

export type CaptureTiming = {
  capturedAtMs: number
  sampledAtMs: number
  acquisitionMs: number
  preparationMs: number
  probeMs?: number
}

function duration(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_MS
}

function percentile(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  }
}

export class DesktopCaptureMetrics {
  private samples: Sample[] = []
  private previous: number | undefined
  private failures = 0
  private restarts = 0
  private dropped = 0
  private cancelled = false

  constructor(private readonly startedAtMs: number) {
    if (!Number.isFinite(startedAtMs) || startedAtMs < 0) throw new Error("Capture metrics need a monotonic start time")
  }

  record(input: CaptureTiming): boolean {
    if (this.cancelled) return false
    const age = input.sampledAtMs - input.capturedAtMs
    const interval = this.previous === undefined ? undefined : input.capturedAtMs - this.previous
    if (
      !Number.isFinite(input.capturedAtMs) ||
      !Number.isFinite(input.sampledAtMs) ||
      input.capturedAtMs < this.startedAtMs ||
      input.sampledAtMs < input.capturedAtMs ||
      !duration(age) ||
      (interval !== undefined && !duration(interval)) ||
      !duration(input.acquisitionMs) ||
      !duration(input.preparationMs) ||
      (input.probeMs !== undefined && !duration(input.probeMs))
    )
      throw new Error("Capture metrics contain invalid or out-of-order timing")
    if (input.sampledAtMs - this.startedAtMs > WINDOW_MS || this.samples.length >= LIMIT) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + 1)
      return false
    }
    this.samples.push({
      age,
      ...(interval === undefined ? {} : { interval }),
      acquisition: input.acquisitionMs,
      preparation: input.preparationMs,
      ...(input.probeMs === undefined ? {} : { probe: input.probeMs }),
    })
    this.previous = input.capturedAtMs
    return true
  }

  failure(atMs: number): boolean {
    if (!this.within(atMs)) return false
    this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1)
    return true
  }

  restart(atMs: number): boolean {
    if (!this.within(atMs)) return false
    this.restarts = Math.min(Number.MAX_SAFE_INTEGER, this.restarts + 1)
    this.previous = undefined
    return true
  }

  private within(atMs: number) {
    return !this.cancelled && Number.isFinite(atMs) && atMs >= this.startedAtMs && atMs - this.startedAtMs <= WINDOW_MS
  }

  snapshot() {
    if (this.cancelled) return null
    return {
      windowMs: WINDOW_MS,
      sampleCount: this.samples.length,
      dropped: this.dropped,
      failures: this.failures,
      restarts: this.restarts,
      frameAgeMs: percentile(this.samples.map((sample) => sample.age)),
      interarrivalMs: percentile(
        this.samples.flatMap((sample) => (sample.interval === undefined ? [] : [sample.interval])),
      ),
      acquisitionMs: percentile(this.samples.map((sample) => sample.acquisition)),
      preparationMs: percentile(this.samples.map((sample) => sample.preparation)),
      probeMs: percentile(this.samples.flatMap((sample) => (sample.probe === undefined ? [] : [sample.probe]))),
    }
  }

  cancel(): void {
    this.cancelled = true
    this.samples.length = 0
    this.previous = undefined
    this.failures = 0
    this.restarts = 0
    this.dropped = 0
  }
}

/** Observe only accepted captures from the already-running worker; never request a frame. */
export function observeCapture(
  worker: Pick<DesktopCaptureWorker, "onSample">,
  signal?: AbortSignal,
  windowMs = WINDOW_MS,
) {
  const metrics = new DesktopCaptureMetrics(performance.now())
  let done = false
  let resolve!: (value: ReturnType<DesktopCaptureMetrics["snapshot"]>) => void
  const result = new Promise<ReturnType<DesktopCaptureMetrics["snapshot"]>>((ready) => {
    resolve = ready
  })
  const off = worker.onSample((sample) => {
    const now = performance.now()
    try {
      metrics.record({
        capturedAtMs: sample.capturedAtMs,
        sampledAtMs: now,
        acquisitionMs: sample.acquisitionMs,
        preparationMs: sample.preparationMs,
      })
    } catch {
      metrics.failure(now)
    }
    if (metrics.snapshot()?.sampleCount === LIMIT) finish()
  })
  const timer = setTimeout(finish, Math.min(WINDOW_MS, Math.max(0, windowMs)))
  const abort = () => cancel()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) cancel()

  function finish() {
    if (done) return
    done = true
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    off()
    resolve(metrics.snapshot())
  }

  function cancel() {
    if (done) return
    metrics.cancel()
    finish()
  }

  return { result, cancel, snapshot: () => metrics.snapshot() }
}
