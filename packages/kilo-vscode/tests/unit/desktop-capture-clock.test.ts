import { describe, expect, test } from "bun:test"
import { DesktopCaptureClock } from "../../src/services/computer-use/desktop-capture-clock"
import { runner } from "../../src/services/computer-use/desktop-windows"

describe("bounded native capture clock mapping", () => {
  test("maps actual Windows Stopwatch counters through the persistent runner without desktop capture", async () => {
    if (process.platform !== "win32") return
    const source = runner()
    try {
      const start = performance.now()
      const value: unknown = JSON.parse(
        await source.run(
          "[ordered]@{ tick = [string][Diagnostics.Stopwatch]::GetTimestamp(); frequency = [string][Diagnostics.Stopwatch]::Frequency } | ConvertTo-Json -Compress",
        ),
      )
      const end = performance.now()
      if (
        !value ||
        typeof value !== "object" ||
        !("tick" in value) ||
        !("frequency" in value) ||
        typeof value.tick !== "string" ||
        typeof value.frequency !== "string"
      )
        throw new Error("Missing real Windows counter")
      const clock = new DesktopCaptureClock()
      if (end - start > 1_500) {
        // Startup is not calibration: measure a second exchange on the already-running process.
        const sent = performance.now()
        const next: unknown = JSON.parse(
          await source.run(
            "[ordered]@{ tick = [string][Diagnostics.Stopwatch]::GetTimestamp(); frequency = [string][Diagnostics.Stopwatch]::Frequency } | ConvertTo-Json -Compress",
          ),
        )
        const received = performance.now()
        if (
          !next ||
          typeof next !== "object" ||
          !("tick" in next) ||
          !("frequency" in next) ||
          typeof next.tick !== "string" ||
          typeof next.frequency !== "string"
        )
          throw new Error("Missing warm Windows counter")
        clock.calibrate(next.tick, next.frequency, sent, received)
        expect(
          clock.bounds(
            { version: 1, acquisition: next.tick, prepared: next.tick, frequency: next.frequency },
            received,
          ),
        ).toEqual({ lower: 0, upper: received - sent, uncertainty: received - sent })
        return
      }
      clock.calibrate(value.tick, value.frequency, start, end)
      expect(
        clock.bounds({ version: 1, acquisition: value.tick, prepared: value.tick, frequency: value.frequency }, end),
      ).toEqual({ lower: 0, upper: end - start, uncertainty: end - start })
    } finally {
      source.cancel()
    }
  }, 15_000)
  const source = { version: 1 as const, acquisition: "980", prepared: "990", frequency: "1000" }
  test("brackets actual acquisition age instead of subtracting stage durations", () => {
    const clock = new DesktopCaptureClock()
    expect(clock.bounds(source, 110)).toBeUndefined()
    clock.calibrate("1000", "1000", 100, 110)
    expect(clock.bounds(source, 140)).toEqual({ lower: 50, upper: 60, uncertainty: 10 })
    expect(clock.bounds(source, 1140)).toBeUndefined()
    expect(clock.bounds({ ...source, frequency: "2000" }, 140)).toBeUndefined()
    clock.clear()
    expect(clock.bounds(source, 140)).toBeUndefined()
  })
  test("rejects reversed source clocks and malformed calibration without fabricating an age", () => {
    const clock = new DesktopCaptureClock()
    expect(() => clock.calibrate("0", "1000", 100, 110)).toThrow()
    expect(() => clock.calibrate("1000", "1000", 110, 100)).toThrow()
    clock.calibrate("1000", "1000", 100, 110)
    expect(() => clock.bounds({ ...source, prepared: "979" }, 140)).toThrow()
    expect(clock.bounds(source, 109)).toBeUndefined()
  })
})
