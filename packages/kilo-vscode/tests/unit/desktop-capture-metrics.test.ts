import { describe, expect, test } from "bun:test"
import {
  DesktopCaptureMetrics,
  observeCapture,
  type CaptureTiming,
} from "../../src/services/computer-use/desktop-capture-metrics"
import { DesktopCaptureWorker } from "../../src/services/computer-use/desktop-capture-worker"

function sample(capturedAtMs: number, age: number, acquisitionMs = 5): CaptureTiming {
  return {
    capturedAtMs,
    sampledAtMs: capturedAtMs + age,
    acquisitionMs,
    preparationMs: acquisitionMs + 2,
    probeMs: acquisitionMs + 4,
  }
}

describe("desktop capture numeric metrics", () => {
  test("reports nonzero acquisition and consumer ages, distinct quiet continuity, and real lifecycle counts", () => {
    const metrics = new DesktopCaptureMetrics(0)
    metrics.event({ kind: "start", at: 1 })
    metrics.event({
      kind: "frame",
      requested: 10,
      received: 40,
      accepted: 45,
      at: 45,
      acquisitionMs: 10,
      preparationMs: 15,
    })
    metrics.event({
      kind: "consumer",
      received: 40,
      accepted: 45,
      at: 60,
      acquisition: { lower: 25, upper: 35, uncertainty: 10 },
    })
    metrics.event({ kind: "continuity", received: 90, accepted: 90, at: 90 })
    metrics.event({ kind: "failure", at: 100 })
    metrics.event({ kind: "stop", at: 101 })
    metrics.event({ kind: "start", at: 120 })
    expect(metrics.snapshot()).toMatchObject({
      version: 2,
      sampleCount: 1,
      frameAgeMs: null,
      continuityCount: 1,
      consumerCount: 1,
      failures: 1,
      restarts: 1,
      requestToReceiptMs: { p50: 30, p95: 30 },
      receiptToConsumerMs: { p50: 20, p95: 20 },
      acquisitionToConsumerLowerMs: { p50: 45, p95: 45 },
      acquisitionToConsumerUpperMs: { p50: 55, p95: 55 },
      calibrationUncertaintyMs: { p50: 10, p95: 10 },
      observationInterarrivalMs: { p50: 45, p95: 45 },
    })
    const before = metrics.snapshot()
    expect(() => metrics.event({ kind: "continuity", at: 119, received: 119, accepted: 119 })).toThrow()
    expect(metrics.snapshot()).toEqual(before)
    metrics.cancel()
    expect(metrics.snapshot()).toBeNull()
  })

  test("observes actual worker failure and restart and quiet receipts without requesting captures", async () => {
    let calls = 0
    const frame = {
      windowID: "0x1",
      location: "private title",
      width: 1,
      height: 1,
      mime: "image/png" as const,
      data: "private pixels",
      timing: { acquisitionMs: 1, preparationMs: 1, totalMs: 2 },
    }
    const worker = new DesktopCaptureWorker(
      async () => {
        if (++calls === 1) throw new Error("private failure")
        return { ...frame, sourceSequence: 7 }
      },
      () => undefined,
      () => undefined,
    )
    const timing = observeCapture(worker)
    worker.start()
    for (let index = 0; index < 100 && timing.snapshot()?.failures !== 1; index++) await Bun.sleep(2)
    expect(timing.snapshot()).toMatchObject({ failures: 1, restarts: 0 })
    worker.start()
    for (let index = 0; index < 100 && !worker.latest(); index++) await Bun.sleep(2)
    const scene = worker.latest()!
    worker.consume(scene)
    expect(worker.renew(7, frame)).toBe(true)
    expect(timing.snapshot()).toMatchObject({ failures: 1, restarts: 1, continuityCount: 1, consumerCount: 1 })
    expect(JSON.stringify(timing.snapshot())).not.toContain("private")
    timing.cancel()
    expect(await timing.result).toBeNull()
    worker.dispose()
  })
  test("computes bounded nearest-rank p50/p95 from real supplied timings", () => {
    const metrics = new DesktopCaptureMetrics(0)
    expect(metrics.snapshot()).toMatchObject({
      sampleCount: 0,
      frameAgeMs: null,
      interarrivalMs: null,
      probeMs: null,
    })
    for (const [index, captured] of [0, 100, 300, 600].entries())
      expect(metrics.record(sample(captured, (index + 1) * 10, index + 5))).toBe(true)
    expect(metrics.snapshot()).toMatchObject({
      sampleCount: 4,
      frameAgeMs: { p50: 20, p95: 40 },
      interarrivalMs: { p50: 200, p95: 300 },
      acquisitionMs: { p50: 6, p95: 8 },
      preparationMs: { p50: 8, p95: 10 },
      probeMs: { p50: 10, p95: 12 },
    })
  })

  test("retains at most 240 samples within sixty seconds", () => {
    const metrics = new DesktopCaptureMetrics(100)
    for (let index = 0; index < 240; index++) expect(metrics.record(sample(100 + index * 100, 5))).toBe(true)
    expect(metrics.record(sample(24_100, 5))).toBe(false)
    expect(metrics.record(sample(60_101, 0))).toBe(false)
    expect(metrics.snapshot()).toMatchObject({ sampleCount: 240, dropped: 2 })
    expect((metrics as unknown as { samples: unknown[] }).samples).toHaveLength(240)
  })

  test("rejects missing, stale, negative, and out-of-order timings without changing statistics", () => {
    const metrics = new DesktopCaptureMetrics(100)
    expect(() => metrics.record(sample(99, 1))).toThrow("invalid or out-of-order")
    expect(() => metrics.record({ ...sample(100, 1), probeMs: Number.NaN })).toThrow("invalid or out-of-order")
    expect(() => metrics.record({ ...sample(100, 1), acquisitionMs: undefined } as unknown as CaptureTiming)).toThrow(
      "invalid or out-of-order",
    )
    expect(() => metrics.record(sample(100, -1))).toThrow("invalid or out-of-order")
    expect(metrics.record(sample(200, 5))).toBe(true)
    expect(() => metrics.record(sample(150, 5))).toThrow("invalid or out-of-order")
    expect(metrics.snapshot()).toMatchObject({ sampleCount: 1, interarrivalMs: null })
  })

  test("counts only in-window failures and restarts, resetting interarrival across restart", () => {
    const metrics = new DesktopCaptureMetrics(100)
    expect(metrics.failure(99)).toBe(false)
    expect(metrics.restart(60_101)).toBe(false)
    expect(metrics.record(sample(100, 5))).toBe(true)
    expect(metrics.failure(500)).toBe(true)
    expect(metrics.restart(600)).toBe(true)
    expect(metrics.record(sample(700, 5))).toBe(true)
    expect(metrics.snapshot()).toMatchObject({ failures: 1, restarts: 1, interarrivalMs: null })
  })

  test("retains only numeric fields and cancellation erases private samples and counts", () => {
    const metrics = new DesktopCaptureMetrics(0)
    const secret = "PRIVATE_PIXELS_AND_TYPED_SECRET"
    const input = { ...sample(100, 5), pixels: secret, text: secret, windowID: secret }
    expect(metrics.record(input)).toBe(true)
    expect(metrics.failure(110)).toBe(true)
    expect(metrics.restart(120)).toBe(true)
    expect(JSON.stringify(metrics.snapshot())).not.toContain(secret)
    expect(JSON.stringify((metrics as unknown as { samples: unknown[] }).samples)).not.toContain(secret)
    metrics.cancel()
    expect((metrics as unknown as { samples: unknown[] }).samples).toEqual([])
    expect(metrics.snapshot()).toBeNull()
    expect(metrics.record(sample(130, 5))).toBe(false)
    expect(metrics.failure(130)).toBe(false)
    expect(metrics.restart(130)).toBe(false)
  })

  test("passively samples the real worker and cancels without returning frame content", async () => {
    const secret = "PRIVATE_CAPTURE_CONTENT"
    let calls = 0
    const worker = new DesktopCaptureWorker(
      async () => {
        calls++
        return {
          windowID: "0x1",
          location: secret,
          width: 1,
          height: 1,
          mime: "image/png",
          data: secret,
          timing: { acquisitionMs: 3, preparationMs: 4, totalMs: 7 },
        }
      },
      () => undefined,
      (error) => {
        throw error
      },
    )
    const controller = new AbortController()
    const timing = observeCapture(worker, controller.signal)
    worker.start()
    for (let index = 0; index < 100 && !worker.latest(); index++) await Bun.sleep(2)
    expect(worker.latest()).toBeDefined()
    expect(calls).toBe(1)
    expect(timing.snapshot()).toMatchObject({
      sampleCount: 1,
      acquisitionMs: { p50: 3, p95: 3 },
      preparationMs: { p50: 4, p95: 4 },
      probeMs: null,
    })
    expect(JSON.stringify(timing.snapshot())).not.toContain(secret)
    controller.abort()
    expect(await timing.result).toBeNull()
    worker.stop()

    const next = observeCapture(worker)
    worker.start()
    for (let index = 0; index < 100 && !worker.latest(); index++) await Bun.sleep(2)
    next.cancel()
    expect(await next.result).toBeNull()
    worker.stop()
  })

  test("completes with empty numeric statistics when an active worker yields no frame", async () => {
    const worker = new DesktopCaptureWorker(
      async () => undefined,
      () => undefined,
      () => undefined,
    )
    worker.start()
    const timing = observeCapture(worker, undefined, 5)
    expect(await timing.result).toMatchObject({
      sampleCount: 0,
      frameAgeMs: null,
      acquisitionMs: null,
      preparationMs: null,
      probeMs: null,
    })
    worker.stop()
  })
})
