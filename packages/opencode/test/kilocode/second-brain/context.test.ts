import { describe, expect, test } from "bun:test"
import { bind, create, fit, prepare } from "@/kilocode/second-brain/context"
import type { ContextResult } from "@/kilocode/second-brain/protocol"
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
  function reply(): ContextResult {
    const sources = Array.from({ length: 6 }, (_, index) => ({
      path: `D:/Raya/SecondBrain/Preferences/Note-${index}.md`,
      relative: `Preferences/Note-${index}.md`,
      line: 8,
      end_line: 9,
      heading: "Voice preferences",
      text: index === 0 ? "Chosen engine: Chatterbox-Nano.\nFallback: Onyx." : "日本語の記録📝".repeat(300),
      source_sha256: "a".repeat(64),
      depth: 0,
      tokens: index === 0 ? 50 : 500,
      truncated: false,
    }))
    return {
      action: "context",
      project: "C:/Raya/project",
      root: "D:/Raya/SecondBrain",
      context: {
        sources,
        diagnostics: Array.from({ length: 80 }, (_, index) => ({
          relative: `Projects/Unavailable-${index}.md`,
          reason: "The selected link is unavailable; its content was not read.".repeat(10),
        })),
        tokens: 2550,
        truncated: false,
        capture_enabled: false,
      },
    }
  }

  test("fits complete cited passages, Unicode and provenance within the actual serialized reservation", () => {
    const f = fixture()
    prepare(f.frame)
    const lease = f.owner.reserve(600, f.signal)
    const value = reply()
    const before = structuredClone(value)
    const selected = fit(value, lease.budget)
    expect(selected.context.sources).toEqual([value.context.sources[0]])
    expect(selected.context.truncated).toBe(true)
    expect(selected.context.tokens).toBe(50)
    expect(JSON.parse(lease.check(selected))).toEqual(selected)
    expect(value).toEqual(before)
    expect(() => lease.check(selected)).toThrow("consumed")
  })

  test("already fitting replies retain diagnostics, passage counters and truncation state", () => {
    const original = reply()
    const value = {
      ...original,
      context: { ...original.context, sources: original.context.sources.slice(0, 1), diagnostics: [], tokens: 50 },
    }
    expect(fit(value, 2000)).toEqual(value)
  })

  test("zero fitting passages remain an explicit empty truncated result without invented answer support", () => {
    const original = reply()
    const value = {
      ...original,
      context: {
        ...original.context,
        sources: original.context.sources.map((source) => ({ ...source, text: "unfittable passage ".repeat(2000) })),
      },
    }
    const f = fixture()
    prepare(f.frame)
    const lease = f.owner.reserve(100, f.signal)
    const selected = fit(value, lease.budget)
    expect(selected.context.sources).toEqual([])
    expect(selected.context.tokens).toBe(0)
    expect(selected.context.truncated).toBe(true)
    expect(JSON.parse(lease.check(selected)).context.sources).toEqual([])
    expect(() => fit(value, 1)).toThrow("provenance")
  })

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
