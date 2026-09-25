import { describe, expect, it } from "bun:test"
import { input, target } from "../../src/services/computer-use/desktop-input-action"

const base = { windowID: "0xABCD", observationID: "obs", sensitive: false as const }

describe("native desktop action encoding", () => {
  it("keeps normalized points and scroll values bounded", () => {
    expect(
      input({ ...base, operation: "pointer", action: "double_click", x: 0.25, y: 1, button: "right" }),
    ).toMatchObject({
      action: "double_click",
      a: 250_000,
      b: 1_000_000,
      c: 1,
    })
    expect(
      input({ ...base, operation: "drag", startX: 0, startY: 0, endX: 1, endY: 0.5, button: "left" }),
    ).toMatchObject({
      action: "drag",
      a: 0,
      b: 0,
      c: 1_000_000,
      d: 500_000,
      e: 0,
    })
    expect(input({ ...base, operation: "scroll", deltaX: -120, deltaY: 240 })).toMatchObject({
      action: "scroll",
      a: -120,
      b: 240,
    })
    expect(() => input({ ...base, operation: "pointer", action: "click", x: 1.01, y: 0 })).toThrow(/normalized/i)
    expect(() => input({ ...base, operation: "scroll", deltaX: 1201, deltaY: 0 })).toThrow(/bounded/i)
  })

  it("encodes a chord once and preserves Unicode code units without logging text", () => {
    expect(input({ ...base, operation: "key", key: "F12", modifiers: ["control", "shift"] })).toMatchObject({
      action: "chord",
      a: 0x7b,
      b: 3,
    })
    expect(() => input({ ...base, operation: "key", key: "A", modifiers: ["shift", "shift"] })).toThrow(/duplicate/i)
    expect(() => input({ ...base, operation: "key", key: "🤖" })).toThrow(/unsupported/i)
    const result = input({ ...base, operation: "type", text: "é🤖" })
    expect(result.action).toBe("text")
    expect(result.payload.toString("utf16le")).toBe("é🤖")
    expect(() => input({ ...base, operation: "type", text: "x".repeat(257) })).toThrow(/bounded/i)
  })

  it("refuses stale or malformed target identities before native dispatch", () => {
    const value = {
      windowID: "0xABCD",
      pid: 42,
      identity: "A".repeat(64),
      left: -10,
      top: 20,
      right: 100,
      bottom: 200,
      scene: 5,
      observedAt: 1_000,
      validUntil: 2_000,
    }
    expect(target(value).windowID).toBe("abcd")
    expect(() => target({ ...value, identity: "" })).toThrow(/target or scene/i)
    expect(() => target({ ...value, validUntil: 11_001 })).toThrow(/target or scene/i)
    expect(() => target({ ...value, left: 100 })).toThrow(/target or scene/i)
  })
})
