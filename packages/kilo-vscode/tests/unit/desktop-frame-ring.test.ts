import { describe, expect, it } from "bun:test"
import { DesktopFrameRing } from "../../src/services/computer-use/desktop-frame-ring"

function frame(id: string, data: string) {
  return { data, observation: { id } }
}

describe("ephemeral desktop frame ring", () => {
  it("evicts the oldest pixels by count and encoded-byte budget", () => {
    const ring = new DesktopFrameRing<ReturnType<typeof frame>>(3, 10)
    ring.set(frame("one", "1111"))
    ring.set(frame("two", "2222"))
    ring.set(frame("three", "33"))
    expect(ring.size()).toEqual({ frames: 3, bytes: 10 })

    ring.set(frame("four", "4444"))
    expect(ring.get("one")).toBeUndefined()
    expect(ring.get("two")).toEqual(frame("two", "2222"))
    expect(ring.get("three")).toEqual(frame("three", "33"))
    expect(ring.get("four")).toEqual(frame("four", "4444"))
    expect(ring.size()).toEqual({ frames: 3, bytes: 10 })

    ring.set(frame("five", "555555555"))
    expect(ring.get("two")).toBeUndefined()
    expect(ring.get("three")).toBeUndefined()
    expect(ring.get("four")).toBeUndefined()
    expect(ring.get("five")).toEqual(frame("five", "555555555"))
    expect(ring.size()).toEqual({ frames: 1, bytes: 9 })
  })

  it("replaces duplicate identities without double-counting and clears immediately", () => {
    const ring = new DesktopFrameRing<ReturnType<typeof frame>>(2, 8)
    ring.set(frame("same", "1234"))
    ring.set(frame("same", "12"))
    expect(ring.size()).toEqual({ frames: 1, bytes: 2 })
    ring.clear()
    expect(ring.get("same")).toBeUndefined()
    expect(ring.size()).toEqual({ frames: 0, bytes: 0 })
  })

  it("refuses invalid limits, oversized frames and missing identities", () => {
    expect(() => new DesktopFrameRing(0, 1)).toThrow(/capacity/i)
    expect(() => new DesktopFrameRing(1, 0)).toThrow(/byte budget/i)
    const ring = new DesktopFrameRing<ReturnType<typeof frame>>(1, 3)
    expect(() => ring.set(frame("large", "1234"))).toThrow(/exceeds/i)
    expect(() => ring.set(frame("", "1"))).toThrow(/identity/i)
  })
})
