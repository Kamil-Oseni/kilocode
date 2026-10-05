import { expect, test } from "bun:test"
import { child, decode, document } from "../../src/second-brain/control/frames"

test("managed JSON documents preserve exact uint64 tokens without a frame newline", () => {
  const raw = Buffer.from('{"root":[18446744073709551615,9007199254740993,1]}')
  const parsed = document(raw)
  const node = child(parsed.tree, "root")
  expect(node.children!.map((item) => parsed.text.slice(item.offset, item.offset + item.length))).toEqual([
    "18446744073709551615",
    "9007199254740993",
    "1",
  ])
  expect(() => decode(raw)).toThrow("Bounded complete frame")
})

test("managed document limits do not change strict control-frame refusal", () => {
  const raw = Buffer.from(JSON.stringify({ assets: Array.from({ length: 33761 }, (_, id) => ({ id, path: "x" })) }))
  expect(() => document(raw, 16777216, 1000000)).not.toThrow()
  expect(() => decode(Buffer.concat([raw, Buffer.from("\n")]), 16777216)).toThrow("JSON structure bound")
  expect(() => document(raw, raw.length - 1, 1000000)).toThrow("Bounded JSON document")
  expect(() => document(raw, 16777216, 20)).toThrow("JSON structure bound")
  expect(() => document(Buffer.from('{"x":1,"x":2}'))).toThrow("Duplicate JSON field")
  expect(() => document(Buffer.from('{"x":1,}'))).toThrow("Strict JSON")
  expect(() => document(Buffer.from('/*x*/{"x":1}'))).toThrow("Strict JSON")
  expect(() => document(Buffer.from([239, 187, 191, 123, 125]))).toThrow("JSON BOM")
  expect(() => document(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]))).toThrow()
})
