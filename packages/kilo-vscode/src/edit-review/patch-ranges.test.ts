import { describe, expect, test } from "bun:test"
import { addedRanges, planReviewLenses } from "./patch-ranges"

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

describe("planReviewLenses", () => {
  test("returns nothing when there are no ranges", () => {
    expect(planReviewLenses([], "/f")).toEqual([])
  })

  test("emits a summary + Keep + Undo cluster for a single hunk", () => {
    const lenses = planReviewLenses([{ start: 4, end: 6 }], "/abs/file.ts")
    expect(lenses).toHaveLength(3)
    expect(lenses[0]).toEqual({ line: 4, title: "$(sparkle) 3 agent lines", command: "" })
    expect(lenses[1]).toEqual({
      line: 4,
      title: "$(check) Keep",
      command: "raya.editReview.keepFile",
      arguments: ["/abs/file.ts"],
    })
    expect(lenses[2]).toEqual({
      line: 4,
      title: "$(discard) Undo",
      command: "raya.editReview.undoFile",
      arguments: ["/abs/file.ts"],
    })
  })

  test("uses the singular badge for a one-line change", () => {
    const lenses = planReviewLenses([{ start: 0, end: 0 }], "/f")
    expect(lenses[0].title).toBe("$(sparkle) 1 agent line")
  })

  test("renders one cluster per hunk, anchored at each hunk start", () => {
    const lenses = planReviewLenses(
      [
        { start: 1, end: 1 },
        { start: 10, end: 12 },
      ],
      "/f",
    )
    // Two hunks -> two clusters of three lenses each.
    expect(lenses).toHaveLength(6)
    // First badge reports the file total (1 + 3 = 4 lines).
    expect(lenses[0]).toEqual({ line: 1, title: "$(sparkle) 4 agent lines", command: "" })
    // Later hunks anchor at their own start and show the hunk size.
    expect(lenses[3]).toEqual({ line: 10, title: "$(sparkle) +3", command: "" })
    expect(lenses[4].line).toBe(10)
    expect(lenses[5].line).toBe(10)
    // Every clickable lens carries the file key so the command targets it.
    expect(lenses.filter((l) => l.command).every((l) => l.arguments?.[0] === "/f")).toBe(true)
  })
})
