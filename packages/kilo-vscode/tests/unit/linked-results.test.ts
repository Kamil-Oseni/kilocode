import { expect, test } from "bun:test"
import { context } from "../../src/second-brain/linked-results"

function fixture() {
  return {
    sources: [
      {
        path: "C:/Memory/Projects/Eden.md",
        relative: "Projects/Eden.md",
        line: 1,
        end_line: 2,
        heading: "Eden",
        text: "Eden café 日本語 😀",
        source_sha256: "a".repeat(64),
        depth: 1,
        tokens: 22,
        truncated: true,
      },
    ],
    diagnostics: [{ relative: "missing.md", reason: "Not approved" }],
    tokens: 22,
    truncated: true,
    capture_enabled: false,
  }
}

test("linked result preserves source provenance, diagnostics and immutable budget data", () => {
  const value = context(fixture(), "C:\\Memory\\", 100)
  expect(value.sources[0].text).toContain("日本語 😀")
  expect(value.sources[0].source_sha256).toBe("a".repeat(64))
  expect(value.diagnostics[0].relative).toBe("missing.md")
  expect(Object.isFrozen(value) && Object.isFrozen(value.sources) && Object.isFrozen(value.sources[0])).toBe(true)
  expect(Object.isFrozen(value.diagnostics) && Object.isFrozen(value.diagnostics[0])).toBe(true)
})

test("linked result refuses roots, hashes, coordinates, depth and duplicate provenance", () => {
  for (const patch of [
    { path: "C:/Other/Projects/Eden.md" },
    { relative: "../Eden.md" },
    { relative: "Health/Eden.md" },
    { source_sha256: "f".repeat(63) },
    { line: 0 },
    { end_line: 0 },
    { tokens: 0 },
    { tokens: 2001 },
    { depth: 3 },
    { depth: 1.5 },
    { truncated: "yes" },
    { text: " " },
    { extra: true },
  ]) {
    const value = fixture()
    Object.assign(value.sources[0], patch)
    expect(() => context(value, "C:/Memory", 12000)).toThrow()
  }
  const duplicate = fixture()
  duplicate.sources.push(duplicate.sources[0])
  duplicate.tokens = 44
  expect(() => context(duplicate, "C:/Memory", 100)).toThrow()
})

test("linked result refuses overstated budgets, inconsistent totals and missing truncation", () => {
  for (const budget of [0, 21, 12001, Number.NaN, Infinity, 1.5])
    expect(() => context(fixture(), "C:/Memory", budget)).toThrow()
  for (const patch of [
    { tokens: 23 },
    { tokens: -1 },
    { capture_enabled: true },
    { truncated: false },
    { extra: true },
  ])
    expect(() => context({ ...fixture(), ...patch }, "C:/Memory", 100)).toThrow()
  expect(() => context({ ...fixture(), sources: Array(13).fill(fixture().sources[0]) }, "C:/Memory", 12000)).toThrow()
  expect(() =>
    context({ ...fixture(), diagnostics: Array(109).fill(fixture().diagnostics[0]) }, "C:/Memory", 100),
  ).toThrow()
})

test("empty exhausted context retains explicit truncation without fabricating a passage", () => {
  expect(
    context({ sources: [], diagnostics: [], tokens: 0, truncated: true, capture_enabled: false }, "C:/Memory", 1),
  ).toEqual({ sources: [], diagnostics: [], tokens: 0, truncated: true, capture_enabled: false })
})

test("disjoint same-note citations retain exact ranges in either order", () => {
  const value = fixture()
  value.sources = [9, 11, 243].map((line) => ({ ...value.sources[0], line, end_line: line, tokens: 22 }))
  value.tokens = 66
  for (const sources of [value.sources, value.sources.toReversed()]) {
    const result = context({ ...value, sources }, "C:/Memory", 100)
    expect(result.sources.map((row) => row.line)).toEqual(sources.map((row) => row.line))
    expect(result.sources.map((row) => row.source_sha256)).toEqual(Array(3).fill("a".repeat(64)))
  }
})

test("same-note citations reject overlap, aliases and conflicting revisions", () => {
  const value = fixture()
  const first = value.sources[0]
  for (const patch of [
    { line: 2, end_line: 3 },
    { line: 1, end_line: 2 },
    { source_sha256: "b".repeat(64) },
    { path: "c:/Memory/Projects/Eden.md" },
    { relative: "projects/Eden.md", path: "C:/Memory/projects/Eden.md" },
  ]) {
    const second = { ...first, line: 4, end_line: 5, ...patch }
    expect(() => context({ ...value, sources: [first, second], tokens: 44 }, "C:/Memory", 100)).toThrow()
  }
})

test("multiple passages share the existing note and global token budgets", () => {
  const value = fixture()
  const first = { ...value.sources[0], tokens: 1000 }
  const second = { ...first, line: 4, end_line: 5 }
  const bounded = { ...value, sources: [first, second], tokens: 2000 }
  expect(context(bounded, "C:/Memory", 2000).tokens).toBe(2000)
  expect(() => context(bounded, "C:/Memory", 1999)).toThrow()
  expect(() =>
    context({ ...bounded, sources: [first, { ...second, tokens: 1001 }], tokens: 2001 }, "C:/Memory", 3000),
  ).toThrow()
})
