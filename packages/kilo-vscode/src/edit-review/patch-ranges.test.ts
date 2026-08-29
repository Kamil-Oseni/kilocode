import { describe, expect, test } from "bun:test"
import { addedRanges } from "./patch-ranges"

describe("addedRanges", () => {
  test("returns nothing for an empty patch", () => {
    expect(addedRanges("")).toEqual([])
  })

  test("covers the whole file for a newly created file", () => {
    const patch = ["--- /dev/null", "+++ b/greeting.txt", "@@ -0,0 +1,3 @@", "+hello", "+there", "+world"].join("\n")
    expect(addedRanges(patch)).toEqual([{ start: 0, end: 2 }])
  })

  test("marks only the added line in a single-line change", () => {
    const patch = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1",
      " const b = 2",
      "+const c = 3",
      " const d = 4",
    ].join("\n")
    expect(addedRanges(patch)).toEqual([{ start: 2, end: 2 }])
  })

  test("ignores deletions but keeps surrounding additions separate", () => {
    const patch = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,4 +1,4 @@",
      " keep",
      "-old one",
      "+new one",
      "-old two",
      "+new two",
      " tail",
    ].join("\n")
    // "new one" lands on new line 2 (idx 1), "new two" on new line 3 (idx 2).
    // The interleaved deletion breaks the run into two adjacent ranges, which
    // paint the same two green lines.
    expect(addedRanges(patch)).toEqual([
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ])
  })

  test("splits non-contiguous additions across hunks", () => {
    const patch = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,2 +1,3 @@",
      " a",
      "+b",
      " c",
      "@@ -10,2 +11,3 @@",
      " j",
      "+k",
      " l",
    ].join("\n")
    expect(addedRanges(patch)).toEqual([
      { start: 1, end: 1 },
      { start: 11, end: 11 },
    ])
  })

  test("coalesces a contiguous added block", () => {
    const patch = ["--- a/f", "+++ b/f", "@@ -1,1 +1,4 @@", " a", "+b", "+c", "+d"].join("\n")
    expect(addedRanges(patch)).toEqual([{ start: 1, end: 3 }])
  })
})
