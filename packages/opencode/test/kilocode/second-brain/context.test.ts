import { describe, expect, test } from "bun:test"
import { bind, create, prepare } from "@/kilocode/second-brain/context"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import { jsonSchema, tool, type ModelMessage } from "ai"

function fixture() {
  const owner = create()
  const tools = bind({ recall: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "" }) }, owner)
  const messages: ModelMessage[] = [{ role: "system", content: "Use approved memories only." }]
  const frame = { originals: tools, tools, messages, context: 8192, output: 1024 }
  return { owner, tools, frame, signal: new AbortController().signal }
}

describe("request-owned Memory context", () => {
  test("refuses before the actual request frame and counts full schemas, messages and output", () => {
    const f = fixture()
    expect(() => f.owner.reserve(100, f.signal)).toThrow("unavailable")
    prepare(f.frame)
    const expected = 8192 - KiloSessionOverflow.measure(f.frame).raw - 1024 - 1024
    expect(f.owner.reserve(12_000, f.signal).budget).toBe(expected)
    expect(() => f.owner.reserve(1, f.signal)).toThrow("No remaining")
  })

  test("parallel reservations share capacity and reported usage is conservative", () => {
    const f = fixture()
    prepare({ ...f.frame, reported: 6000 })
    expect(f.owner.reserve(100, f.signal).budget).toBe(100)
    expect(f.owner.reserve(200, f.signal).budget).toBe(44)
    expect(() => f.owner.reserve(1, f.signal)).toThrow("No remaining")
  })

  test("cancellation, supersession and consumed output refuse publication", () => {
    const f = fixture()
    prepare(f.frame)
    const cancelled = new AbortController()
    const lease = f.owner.reserve(100, cancelled.signal)
    cancelled.abort()
    expect(() => lease.check({ text: "note" })).toThrow()
    expect(() => f.owner.reserve(100, cancelled.signal)).toThrow()
    const old = f.owner.reserve(100, f.signal)
    prepare(f.frame)
    expect(() => old.check({ text: "note" })).toThrow("superseded")
    const current = f.owner.reserve(100, f.signal)
    expect(JSON.parse(current.check({ text: "note" }))).toEqual({ text: "note" })
    expect(() => current.check({ text: "note" })).toThrow("consumed")
  })

  test("bounds the entire serialized result and does not refund rejected output", () => {
    const f = fixture()
    prepare({ ...f.frame, reported: 6044 })
    const lease = f.owner.reserve(100, f.signal)
    expect(() => lease.check({ metadata: "x".repeat(1000), text: "small note" })).toThrow("exceeds")
    expect(() => lease.check({ text: "retry" })).toThrow("consumed")
    expect(() => f.owner.reserve(1, f.signal)).toThrow("No remaining")
  })

  test("unknown capacity, invalid limits and oversized schemas fail closed", () => {
    for (const context of [0, -1, NaN, Infinity]) {
      const f = fixture()
      prepare({ ...f.frame, context })
      expect(() => f.owner.reserve(100, f.signal)).toThrow("unavailable")
    }
    const f = fixture()
    prepare({ ...f.frame, output: undefined })
    expect(() => f.owner.reserve(100, f.signal)).toThrow("unavailable")
    prepare({ ...f.frame, messages: [{ role: "system", content: "x".repeat(100_000) }] })
    expect(() => f.owner.reserve(100, f.signal)).toThrow("No remaining")
    for (const budget of [0, -1, 1.5, 12_001, NaN]) expect(() => f.owner.reserve(budget, f.signal)).toThrow("Invalid")
  })

  test("copies preserve the original executor owner; mixed owners never multiply allowance", () => {
    const f = fixture()
    prepare({ ...f.frame, originals: { recall: { ...f.tools.recall } } })
    expect(f.owner.reserve(100, f.signal).budget).toBe(100)
    const g = fixture()
    prepare({ ...f.frame, originals: { recall: f.tools.recall, other: g.tools.recall } })
    expect(() => f.owner.reserve(100, f.signal)).toThrow("unavailable")
    expect(() => g.owner.reserve(100, g.signal)).toThrow("unavailable")
  })
})
