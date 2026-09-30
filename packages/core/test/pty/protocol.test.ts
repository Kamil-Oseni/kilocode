import { describe, expect, test } from "bun:test"
import { PtyProtocol } from "@opencode-ai/core/pty/protocol"

describe("pty protocol", () => {
  test("drops invalid binary input frames and decodes valid ones", () => {
    expect(PtyProtocol.decodeInput("ready")).toBe("ready")
    expect(PtyProtocol.decodeInput(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeUndefined()
    expect(PtyProtocol.decodeInput(new TextEncoder().encode("hello"))).toBe("hello")
    expect(PtyProtocol.decodeInput(new TextEncoder().encode("hello").buffer)).toBe("hello")
  })

  test("encodes the cursor as a 0x00-prefixed JSON control frame", () => {
    const frame = PtyProtocol.metaFrame(42)
    expect(frame[0]).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(1)))).toEqual({ cursor: 42 })
  })

  // kilocode_change start - additive PTY replay-loss metadata compatibility.
  test("adds exact retained-range loss without changing cursor-only frames", () => {
    const gap = { requestedCursor: 14, retainedFrom: 90, retainedTo: 150 }
    const frame = PtyProtocol.metaFrame(150, gap)
    expect(frame[0]).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(1)))).toEqual({ cursor: 150, replayGap: gap })
    expect(JSON.parse(new TextDecoder().decode(PtyProtocol.metaFrame(150).subarray(1)))).toEqual({ cursor: 150 })
  })
  // kilocode_change end

  test("splits replay into bounded frames", () => {
    expect(PtyProtocol.chunks("")).toEqual([])
    expect(PtyProtocol.chunks("abc")).toEqual(["abc"])
    const big = "x".repeat(PtyProtocol.REPLAY_CHUNK + 1)
    const frames = PtyProtocol.chunks(big)
    expect(frames.length).toBe(2)
    expect(frames[0].length).toBe(PtyProtocol.REPLAY_CHUNK)
    expect(frames.join("")).toBe(big)
  })
})
