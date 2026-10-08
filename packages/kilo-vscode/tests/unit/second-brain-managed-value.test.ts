import { expect, test } from "bun:test"
import { document } from "../../src/second-brain/control/frames"
import { parse } from "../../src/second-brain/managed/value"

test("large plan values match exact document values without token trees", () => {
  const raw = Buffer.from(
    JSON.stringify({
      assets: Array.from({ length: 26040 }, (_, id) => ({
        id,
        path: `source/${id}`,
        bytes: 1234,
        sha256: "a".repeat(64),
      })),
      env: { tuple: "[18446744073709551615,9007199254740993,1]" },
    }),
  )
  expect(parse(raw)).toEqual(document(raw, 16777216, 1000000).value)
  expect(parse(Buffer.from('{"__proto__":{"value":1},"":null,"nested":[true,false,{},[]]}'))).toEqual(
    document(Buffer.from('{"__proto__":{"value":1},"":null,"nested":[true,false,{},[]]}')).value,
  )
})

test("value-only plans retain strict syntax, encoding, depth and exact node bounds", () => {
  const cases = [
    '{"x":1,"x":2}',
    '{"x":1,"\\u0078":2}',
    '{"x":1,}',
    '/*x*/{"x":1}',
    '{"x":1}//x',
    '{"x":NaN}',
    '{"x":1e999}',
    '{"x":}',
    "{} {}",
    "{} trailing",
    '{"x":01}',
    '{"x":"\\q"}',
    "[]",
    "null",
    "1",
  ]
  for (const text of cases) expect(() => parse(Buffer.from(text))).toThrow()
  for (const raw of [Buffer.from([239, 187, 191, 123, 125]), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])])
    expect(() => parse(raw)).toThrow()
  const raw = Buffer.from('{"x":[{},1]}')
  expect(parse(raw, raw.length, 6)).toEqual(document(raw, raw.length, 6).value)
  expect(() => parse(raw, raw.length, 5)).toThrow("JSON structure bound")
  expect(() => parse(raw, raw.length - 1)).toThrow("Bounded JSON document")
  for (const depth of [15, 16, 17, 31, 32, 33]) {
    const text = '{"x":'.repeat(depth) + "{}" + "}".repeat(depth)
    const raw = Buffer.from(text)
    if (depth <= 16) expect(parse(raw)).toEqual(document(raw).value)
    if (depth > 16) expect(() => parse(raw)).toThrow("JSON structure bound")
  }
})
