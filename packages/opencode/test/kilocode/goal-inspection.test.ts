import { expect, test } from "bun:test"
import { inspection } from "@opencode-ai/core/kilocode/evidence-inspection"

test("read coverage distinguishes partial presentation from full review", () => {
  const metadata = {
    truncated: false,
    display: { type: "file", lineStart: 1, lineEnd: 3, totalLines: 3, truncated: false },
  }
  expect(inspection(metadata)).toEqual({
    kind: "text",
    coverage: "displayed",
    lineStart: 1,
    lineEnd: 3,
    reportedLines: 3,
    fullReview: "not-established",
  })
  for (const display of [
    { ...metadata.display, lineStart: 2 },
    { ...metadata.display, lineEnd: 1 },
    { ...metadata.display, truncated: true },
  ])
    expect(inspection({ ...metadata, display }).coverage).toBe("partial")
  expect(inspection({ ...metadata, truncated: true }).coverage).toBe("partial")
  expect(inspection({ truncated: false, display: { ...metadata.display, lineEnd: 0, totalLines: 0 } }).coverage).toBe(
    "displayed",
  )
})

test("unknown and inconsistent read metadata cannot imply known coverage", () => {
  for (const display of [
    undefined,
    {},
    { type: "image" },
    { type: "file", lineStart: 1, lineEnd: 2, totalLines: 1, truncated: false },
    { type: "file", lineStart: -1, lineEnd: 2, totalLines: 2, truncated: false },
  ])
    expect(inspection({ truncated: false, display }).coverage).toBe("unknown")
  expect(inspection({ display: { type: "directory" } })).toEqual({ kind: "directory", coverage: "listing" })
})
