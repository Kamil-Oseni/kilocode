import { describe, expect, it } from "bun:test"
import {
  bounded,
  changed,
  DesktopCadence,
  firstChanged,
  limit,
  WATCH,
} from "../../src/services/computer-use/desktop-cadence"

describe("adaptive desktop capture cadence", () => {
  it("samples changed scenes quickly and backs off only while pixels stay stable", () => {
    const cadence = new DesktopCadence(800)
    expect([cadence.next(true), cadence.next(false), cadence.next(false), cadence.next(false)]).toEqual([
      50, 100, 200, 400,
    ])
    expect(cadence.next(true)).toBe(50)
    expect([cadence.next(false), cadence.next(false), cadence.next(false), cadence.next(false)]).toEqual([
      100, 200, 400, 800,
    ])
    expect(cadence.next(false)).toBe(800)
  })

  it("refuses unbounded frame, interval and estimated-duration combinations", () => {
    expect(bounded(2, 50)).toBe(true)
    expect(bounded(16, 50)).toBe(true)
    expect(bounded(17, 50)).toBe(false)
    expect(bounded(2, 49)).toBe(false)
    expect(bounded(2, 1_001)).toBe(false)
    expect(bounded(8, 1_000)).toBe(false)
    expect(() => new DesktopCadence(WATCH.maximum + 1)).toThrow(/bounded interval/i)
  })

  it("accelerates only for exact visual or target changes", () => {
    const frame = {
      windowID: "window",
      location: "pid:1;title:Editor",
      width: 100,
      height: 50,
      mime: "image/png",
      data: "pixels",
    }
    expect(changed(undefined, frame)).toBe(true)
    expect(changed(frame, { ...frame })).toBe(false)
    expect(changed(frame, { ...frame, data: "changed" })).toBe(true)
    expect(changed(frame, { ...frame, location: "pid:2;title:Editor" })).toBe(true)
    expect(firstChanged(undefined, frame, 0, "first_change_v2")).toBe(false)
    expect(firstChanged(frame, { ...frame }, 1, "first_change_v2")).toBe(false)
    expect(firstChanged(frame, { ...frame, data: "changed" }, 1)).toBe(false)
    expect(firstChanged(frame, { ...frame, data: "changed" }, 1, "first_change_v2")).toBe(true)
    expect(firstChanged(frame, { ...frame, location: "pid:2;title:Editor" }, 1, "first_change_v2")).toBe(true)
  })

  it("cancels a capture at its hard deadline and clears completed timers", async () => {
    const state = { expired: 0 }
    await expect(
      limit(new Promise<never>(() => undefined), 5, () => {
        state.expired += 1
      }),
    ).rejects.toThrow(/exceeded the ten-second/i)
    expect(state.expired).toBe(1)

    expect(await limit(Promise.resolve("done"), 5, () => (state.expired += 1))).toBe("done")
    await Bun.sleep(10)
    expect(state.expired).toBe(1)
  })
})
