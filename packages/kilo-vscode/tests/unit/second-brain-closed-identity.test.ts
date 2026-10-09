import { expect, test } from "bun:test"
import { newer } from "../../src/second-brain/closed-recovery"

test("recorded newer creation lower bound exceeds the original exact kernel birth without numeric rounding", () => {
  const original = "134360290023545017"
  // Retained Win32_Process creation time; truncation to milliseconds is a lower bound.
  const birth = ((BigInt(Date.parse("2026-10-09T10:23:31.124765-04:00")) + 11644473600000n) * 10000n).toString()
  const current = { status: "owned", birth, parent: 19080 }
  expect(newer(original, current)).toEqual(current)
  expect(newer("18446744073709551614", { status: "owned", birth: "18446744073709551615", parent: 1 }).birth).toBe(
    "18446744073709551615",
  )
  expect(newer(original, { status: "gone", birth: null, parent: 0 }).status).toBe("gone")
})

test("same, older, unverified and out-of-range kernel identities remain refused", () => {
  const original = "134360290023545017"
  for (const current of [
    { status: "owned", birth: original, parent: 19080 },
    { status: "owned", birth: "134360290023545016", parent: 19080 },
    { status: "unknown", birth: null, parent: 0 },
    { status: "foreign", birth: "134360294111240000", parent: 19080 },
    { status: "owned", birth: "134360294111240000", parent: 0 },
    { status: "owned", birth: "18446744073709551616", parent: 19080 },
    { status: "owned", birth: "0134360294111240000", parent: 19080 },
  ])
    expect(() => newer(original, current)).toThrow()
  expect(() => newer("0", { status: "gone", birth: null, parent: 0 })).toThrow()
})
