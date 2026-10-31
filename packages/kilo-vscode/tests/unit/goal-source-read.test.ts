import { expect, test } from "bun:test"
import { valid, equal } from "../../src/shared/goal-criteria"
import { report } from "../../src/shared/goal-report"

const check = {
  kind: "source-read" as const,
  path: "C:/work/input.json",
  canonical: "C:/work/input.json",
  sha256: "a".repeat(64),
  bytes: 8192,
}
const criteria = [{ id: "input", description: "Read approved input", verification: "Pinned native Read", check }]

test("pinned inputs validate and retain every immutable field", () => {
  expect(valid(criteria)).toBe(true)
  expect(equal(criteria, structuredClone(criteria))).toBe(true)
  for (const value of [
    { ...check, path: "relative" },
    { ...check, canonical: "relative" },
    { ...check, path: "/" + "x".repeat(4000) },
    { ...check, sha256: "A".repeat(64) },
    { ...check, bytes: -1 },
    { ...check, bytes: 1.5 },
    { ...check, bytes: 8193 },
    { ...check, extra: true },
    { kind: "source-read", path: check.path },
  ])
    expect(valid([{ ...criteria[0], check: value }])).toBe(false)
  expect(valid([{ ...criteria[0], check: { ...check, bytes: 0 } }])).toBe(true)
  for (const value of [
    { ...check, path: "C:/other" },
    { ...check, canonical: "C:/other" },
    { ...check, sha256: "b".repeat(64) },
    { ...check, bytes: 1 },
  ])
    expect(equal(criteria, [{ ...criteria[0], check: value }])).toBe(false)
  expect(equal(criteria, [{ ...criteria[0], check: { kind: "command", command: "read", directory: "C:/work" } }])).toBe(
    false,
  )
})

test("exported pinned inputs describe acquisition without claiming factual verification", () => {
  const text = report({ objective: "Use input", status: "paused", createdAt: 0, updatedAt: 1, criteria })
  expect(text).toContain("Saved pinned source-read check (read-only)")
  expect(text).toContain(check.path)
  expect(text).toContain(check.canonical)
  expect(text).toContain(check.sha256)
  expect(text).toContain("Source bytes: 8192")
  expect(text).toContain("this worker's fresh full native Read")
  expect(text).toContain("Grants no Read permission; factual accuracy is not verified")
  expect(text).not.toContain("Saved exact byte-equality check")
  expect(text).not.toContain("Required command:")
})
