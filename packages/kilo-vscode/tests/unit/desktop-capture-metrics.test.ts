import { describe, expect, test } from "bun:test"
import { DesktopCaptureMetrics, type CaptureTiming } from "../../src/services/computer-use/desktop-capture-metrics"

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
    expect(() => metrics.record({ ...sample(100, 1), probeMs: undefined } as unknown as CaptureTiming)).toThrow(
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
})
