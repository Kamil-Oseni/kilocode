// In-memory numeric capture measurements from an active installed host.
// A probe duration is optional because DesktopFrame does not measure one.
import type { DesktopCaptureWorker, CaptureEvent } from "./desktop-capture-worker"
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

function validate(input: CaptureEvent, previous: number | undefined) {
  const stamps = [input.requested, input.received, input.accepted, input.at].filter(
    (value): value is number => value !== undefined,
  )
  if (
    stamps.some((value) => !Number.isFinite(value) || value < 0) ||
    stamps.some((value, index) => index > 0 && value < stamps[index - 1]) ||
    (previous !== undefined && input.at < previous)
  )
    throw new Error("Capture event clock is invalid or stale")
  if (
    input.acquisition &&
    (![input.acquisition.lower, input.acquisition.upper, input.acquisition.uncertainty].every(duration) ||
      input.acquisition.lower > input.acquisition.upper)
  )
    throw new Error("Capture acquisition age bound is invalid")
  if (
    (input.kind === "frame" || input.kind === "continuity") &&
    (input.received === undefined || input.accepted === undefined)
  )
    throw new Error("Capture event needs source timestamps")
  if (input.kind === "frame" && (!duration(input.acquisitionMs!) || !duration(input.preparationMs!)))
    throw new Error("Capture event stage duration is invalid")
  if (input.kind === "consumer" && (input.received === undefined || !duration(input.at - input.received)))
    throw new Error("Capture consumer needs a bounded receipt timestamp")
}

export class DesktopCaptureMetrics {
  private samples: Sample[] = []
  private previous: number | undefined
  private failures = 0
  private restarts = 0
  private dropped = 0
  private cancelled = false
  private rejected = 0
  private events = 0
  private started = false
  private continuity = 0
  private consumers = 0
  private last: number | undefined
  private readonly intervals: number[] = []
  private observation: number | undefined
  private readonly requests: number[] = []
  private readonly receipts: number[] = []
  private readonly acceptance: number[] = []
  private readonly lower: number[] = []
  private readonly upper: number[] = []
  private readonly uncertainty: number[] = []

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

  event(input: CaptureEvent): boolean {
    if (!this.within(input.at) || this.events >= LIMIT) return false
    validate(input, this.last)
    if (input.kind === "frame" && input.received! < this.startedAtMs) return false
    this.events++
    this.last = input.at
    if (input.kind === "start") {
      if (this.started) this.restart(input.at)
      this.started = true
      return true
    }
    if (input.kind === "failure") return this.failure(input.at)
    if (input.kind === "stop") return true
    this.started = true
    if (input.kind === "consumer") {
      this.consumers++
      this.receipts.push(input.at - input.received!)
      if (input.acquisition && duration(input.acquisition.upper + input.at - input.received!)) {
        this.lower.push(input.acquisition.lower + input.at - input.received!)
        this.upper.push(input.acquisition.upper + input.at - input.received!)
        this.uncertainty.push(input.acquisition.uncertainty)
      }
      return true
    }
    if (this.observation !== undefined) this.intervals.push(input.at - this.observation)
    this.observation = input.at
    this.acceptance.push(input.accepted! - input.received!)
    if (input.requested !== undefined) this.requests.push(input.received! - input.requested)
    if (input.kind === "continuity") {
      this.continuity++
      return true
    }
    if (input.unchanged === 1) this.continuity++
    return this.record({
      capturedAtMs: input.received!,
      sampledAtMs: input.at,
      acquisitionMs: input.acquisitionMs!,
      preparationMs: input.preparationMs!,
    })
  }

  failure(atMs: number): boolean {
    if (!this.within(atMs)) return false
    this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1)
    return true
  }

  reject(atMs: number): boolean {
    if (!this.within(atMs)) return false
    this.rejected = Math.min(Number.MAX_SAFE_INTEGER, this.rejected + 1)
    return true
  }

  restart(atMs: number): boolean {
    if (!this.within(atMs)) return false
    this.restarts = Math.min(Number.MAX_SAFE_INTEGER, this.restarts + 1)
    this.previous = undefined
    this.observation = undefined
    return true
  }

  private within(atMs: number) {
    return !this.cancelled && Number.isFinite(atMs) && atMs >= this.startedAtMs && atMs - this.startedAtMs <= WINDOW_MS
  }

  snapshot() {
    if (this.cancelled) return null
    return {
      version: 2,
      windowMs: WINDOW_MS,
      sampleCount: this.samples.length,
      dropped: this.dropped,
      failures: this.failures,
      invalidSamples: this.rejected,
      restarts: this.restarts,
      frameAgeMs: this.events ? null : percentile(this.samples.map((sample) => sample.age)),
      interarrivalMs: percentile(
        this.samples.flatMap((sample) => (sample.interval === undefined ? [] : [sample.interval])),
      ),
      acquisitionMs: percentile(this.samples.map((sample) => sample.acquisition)),
      preparationMs: percentile(this.samples.map((sample) => sample.preparation)),
      probeMs: percentile(this.samples.flatMap((sample) => (sample.probe === undefined ? [] : [sample.probe]))),
      eventCount: this.events,
      continuityCount: this.continuity,
      consumerCount: this.consumers,
      calibratedConsumerCount: this.lower.length,
      requestToReceiptMs: percentile(this.requests),
      receiptToAcceptanceMs: percentile(this.acceptance),
      receiptToConsumerMs: percentile(this.receipts),
      acquisitionToConsumerLowerMs: percentile(this.lower),
      acquisitionToConsumerUpperMs: percentile(this.upper),
      calibrationUncertaintyMs: percentile(this.uncertainty),
      observationInterarrivalMs: percentile(this.intervals),
    }
  }

  cancel(): void {
    this.cancelled = true
    this.samples.length = 0
    this.previous = undefined
    this.failures = 0
    this.rejected = 0
    this.restarts = 0
    this.dropped = 0
    this.events = 0
    this.continuity = 0
    this.consumers = 0
    this.started = false
    this.last = undefined
    this.observation = undefined
    for (const values of [
      this.intervals,
      this.requests,
      this.receipts,
      this.acceptance,
      this.lower,
      this.upper,
      this.uncertainty,
    ])
      values.length = 0
  }
}

/** Observe only accepted captures from the already-running worker; never request a frame. */
export function observeCapture(
  worker: Pick<DesktopCaptureWorker, "onEvent">,
  signal?: AbortSignal,
  windowMs = WINDOW_MS,
) {
  const metrics = new DesktopCaptureMetrics(performance.now())
  let done = false
  let resolve!: (value: ReturnType<DesktopCaptureMetrics["snapshot"]>) => void
  const result = new Promise<ReturnType<DesktopCaptureMetrics["snapshot"]>>((ready) => {
    resolve = ready
  })
  const off = worker.onEvent((sample) => {
    const now = performance.now()
    try {
      metrics.event(sample)
    } catch {
      metrics.reject(now)
    }
    if (metrics.snapshot()?.eventCount === LIMIT) finish()
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
