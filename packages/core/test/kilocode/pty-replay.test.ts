import { describe, expect, test } from "bun:test"
import { Replay } from "../../src/kilocode/pty/replay"

describe("segmented PTY replay retention", () => {
  test("retains nothing before output and validates its fixed upper budget", () => {
    const replay = new Replay(2 * 1024 * 1024)
    expect(replay.length).toBe(0)
    expect(replay.capacity).toBe(0)
    expect(replay.slice()).toBe("")
    expect(replay.append("")).toBe(0)
    for (const limit of [0, -1, 0.5, NaN, Infinity, 2 * 1024 * 1024 + 1])
      expect(() => new Replay(limit)).toThrow("limit invalid")
  })

  test("tiny chunks cannot multiply fragments beyond the retained UTF-16 capacity", () => {
    const replay = new Replay(4097)
    for (let n = 0; n < 20_000; n++) replay.append(String.fromCharCode(65 + (n % 26)))
    expect(replay.length).toBe(4097)
    expect(replay.capacity).toBe(4097)
    const expected = Array.from({ length: 4097 }, (_, n) => String.fromCharCode(65 + ((15_903 + n) % 26))).join("")
    expect(replay.slice()).toBe(expected)
    expect(replay.slice(4096)).toBe(expected.at(-1)!)
    expect(replay.slice(4097)).toBe("")
    expect(replay.slice(5000)).toBe("")
  })

  test("oversized input retains only its bounded tail and returns exact dropped cursor units", () => {
    const replay = new Replay(8193)
    replay.append("before")
    const input = "discarded".repeat(100_000) + "x".repeat(8192) + "z"
    expect(replay.append(input)).toBe(6 + input.length - 8193)
    expect(replay.length).toBe(8193)
    expect(replay.capacity).toBe(8193)
    expect(replay.slice()).toBe("x".repeat(8192) + "z")
    expect(replay.append("end")).toBe(3)
    expect(replay.slice(-4)).toBe("zend")
  })

  test("preserves surrogate pairs and lone UTF-16 units across segment and retention boundaries", () => {
    const replay = new Replay(4100)
    replay.append("x".repeat(4095) + "\ud83d")
    replay.append("\ude00\ud800\udc00\udfff")
    expect(replay.slice(4095)).toBe("😀𐀀\udfff")
    expect(replay.append("a")).toBe(1)
    expect(replay.slice(4094)).toBe("😀𐀀\udfffa")
    const short = new Replay(3)
    short.append("😀𐀀")
    expect(short.slice()).toBe("\ude00𐀀")
    expect(short.length).toBe(3)
  })

  test("multiple full-budget rollovers preserve cursor arithmetic and interior replay", () => {
    const limit = 2 * 1024 * 1024
    const replay = new Replay(limit)
    let cursor = 0
    let start = 0
    for (let n = 0; n < 8; n++) {
      const chunk = String.fromCharCode(65 + n).repeat(limit + 17)
      cursor += chunk.length
      start += replay.append(chunk)
      expect(cursor - start).toBe(limit)
      expect(replay.length).toBe(limit)
      expect(replay.capacity).toBe(limit)
      expect(replay.slice(limit - 31)).toBe(String.fromCharCode(65 + n).repeat(31))
    }
    expect(replay.slice()).toBe("H".repeat(limit))
  })
})
