export type CaptureClock = { version: 1; acquisition: string; prepared: string; frequency: string }

export function parse(value: unknown): CaptureClock | undefined {
  if (value === undefined) return
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Capture source clock is invalid")
  const clock = value as Record<string, unknown>
  if (
    clock.version !== 1 ||
    ![clock.acquisition, clock.prepared, clock.frequency].every(
      (item) => typeof item === "string" && /^[1-9]\d{0,18}$/.test(item),
    ) ||
    BigInt(String(clock.prepared)) < BigInt(String(clock.acquisition)) ||
    BigInt(String(clock.frequency)) > 10_000_000_000n
  )
    throw new Error("Capture source clock is invalid")
  return {
    version: 1,
    acquisition: String(clock.acquisition),
    prepared: String(clock.prepared),
    frequency: String(clock.frequency),
  }
}

function tick(value: string) {
  if (!/^[1-9]\d{0,18}$/.test(value)) throw new Error("Capture clock tick is invalid")
  return BigInt(value)
}

/** A bounded round-trip calibration; no assumed equality between process clock epochs. */
export class DesktopCaptureClock {
  private calibration: { tick: bigint; frequency: bigint; start: number; end: number } | undefined

  calibrate(value: string, frequency: string, start: number, end: number) {
    const rate = tick(frequency)
    if (
      rate > 10_000_000_000n ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      end - start > 1_500
    )
      throw new Error("Capture clock calibration is invalid")
    this.calibration = { tick: tick(value), frequency: rate, start, end }
  }

  bounds(clock: CaptureClock, now: number) {
    const saved = this.calibration
    const acquisition = tick(clock.acquisition)
    const prepared = tick(clock.prepared)
    const frequency = tick(clock.frequency)
    if (clock.version !== 1 || prepared < acquisition || frequency > 10_000_000_000n)
      throw new Error("Capture source clock is invalid")
    if (!saved || frequency !== saved.frequency || now < saved.end || now - saved.end > 1_000) return
    const delta = (Number(acquisition - saved.tick) * 1_000) / Number(frequency)
    if (!Number.isFinite(delta) || Math.abs(delta) > 120_000) return
    const lower = Math.max(0, now - saved.end - delta)
    const upper = now - saved.start - delta
    if (upper < 0 || upper > 120_000) return
    return { lower, upper, uncertainty: saved.end - saved.start }
  }

  clear() {
    this.calibration = undefined
  }
}
