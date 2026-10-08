import { expect, test } from "bun:test"
import { media } from "../../src/shared/media"

const id = "a".repeat(64)
const query = "b".repeat(64)
const selection = { root: "D:\\Raya\\Media", query, top: 5 }
const item = {
  id,
  kind: "image",
  relative: "Assets/" + id + ".png",
  sha256: id,
  title: "Synthetic image",
  origin: "D:\\Fixtures\\image.png",
  imported: 1,
  similarity: 0.99,
  path: "D:\\Raya\\Media\\Assets\\" + id + ".png",
  verification: "supported",
  evidence: "A teal square is visible.",
  verifier: "fixture-contract",
  query_sha256: query,
}
const reply = () => ({
  format: "raya.media.recall.v1",
  query_sha256: query,
  matches: [{ ...item }],
  rejected: [],
  uncertain: [],
})

test("media projection retains source evidence and preserves decision groups", () => {
  const result = media(reply(), selection)
  expect(result.matches[0].source_sha256).toBe(id)
  expect(result.matches[0].start).toBeNull()
  expect(Object.isFrozen(result.matches[0])).toBe(true)
  for (const status of ["rejected", "uncertain"] as const) {
    const value = reply()
    const row = { ...value.matches[0], verification: status }
    value.matches = []
    const result = media({ ...value, [status]: [row] }, selection)
    expect(result.matches).toEqual([])
    expect(result[status]).toHaveLength(1)
  }
})

test("media decoder rejects query replay and substituted content identity", () => {
  expect(() => media(reply(), { ...selection, query: "c".repeat(64) })).toThrow("query")
  for (const patch of [{ sha256: "c".repeat(64) }, { query_sha256: "c".repeat(64) }, { verification: "uncertain" }])
    expect(() => media({ ...reply(), matches: [{ ...item, ...patch }] }, selection)).toThrow("binding")
})

test("media decoder binds snapshots to exact selected content addresses", () => {
  for (const patch of [
    { path: "E:\\Other\\Assets\\" + id + ".png" },
    { relative: "Assets/../" + id + ".png" },
    { relative: "Assets/" + id + ".exe" },
    { kind: "audio" },
  ])
    expect(() => media({ ...reply(), matches: [{ ...item, ...patch }] }, selection)).toThrow("address")
})

test("recording evidence preserves bounded exact spans and images cannot claim them", () => {
  const row = {
    ...item,
    kind: "audio",
    relative: "Assets/" + id + ".wav",
    path: selection.root + "\\Assets\\" + id + ".wav",
    start: 1.25,
    end: 3.5,
  }
  expect(media({ ...reply(), matches: [row] }, selection).matches[0].start).toBe(1.25)
  for (const patch of [{ start: -1 }, { start: 4 }, { end: 61 }, { end: Number.NaN }])
    expect(() => media({ ...reply(), matches: [{ ...row, ...patch }] }, selection)).toThrow("timestamp")
  expect(() => media({ ...reply(), matches: [{ ...item, start: 0, end: 1 }] }, selection)).toThrow("timestamp")
})

test("media decoder rejects malformed evidence, nonfinite similarity and oversized UTF-8", () => {
  for (const patch of [
    { evidence: " " },
    { evidence: "界".repeat(1366) },
    { verifier: "" },
    { similarity: Infinity },
    { similarity: 1.01 },
  ])
    expect(() => media({ ...reply(), matches: [{ ...item, ...patch }] }, selection)).toThrow("invalid")
  expect(() => media({ ...reply(), matches: [{ ...item, confidence: 1 }] }, selection)).toThrow("fields")
})

test("a media source/span cannot appear in conflicting decision groups", () => {
  expect(() => media({ ...reply(), uncertain: [{ ...item, verification: "uncertain" }] }, selection)).toThrow(
    "Duplicate",
  )
  expect(() => media({ ...reply(), matches: [item, item] }, { ...selection, top: 1 })).toThrow("bound")
  expect(() => media(reply(), { ...selection, top: 11 })).toThrow("bound")
})
