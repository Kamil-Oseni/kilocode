import { expect, test } from "bun:test"
import { validate } from "@/kilocode/goal/plan"

const task = {
  id: "one",
  description: "Work",
  output: "Result",
  owner: "code",
  verification: "Check",
  status: "pending" as const,
  dependencies: [] as string[],
}

test("goal plan validation rejects invalid graphs and permits independent work", () => {
  expect(validate([task, task])).toContain("unique")
  expect(validate([{ ...task, dependencies: ["missing"] }])).toContain("Missing dependency")
  expect(validate([{ ...task, dependencies: ["one"] }])).toContain("itself")
  expect(
    validate([
      { ...task, dependencies: ["two", "two"] },
      { ...task, id: "two" },
    ]),
  ).toContain("Duplicate dependencies")
  expect(
    validate([
      { ...task, dependencies: ["two"] },
      { ...task, id: "two", dependencies: ["one"] },
    ]),
  ).toContain("cycle")
  expect(
    validate([
      { ...task, status: "completed" },
      { ...task, id: "two", status: "in_progress", dependencies: ["one"] },
    ]),
  ).toBeUndefined()
  expect(
    validate([
      { ...task, status: "cancelled" },
      { ...task, id: "two", status: "completed", dependencies: ["one"] },
    ]),
  ).toContain("until dependency one is completed")
  expect(
    validate([
      { ...task, status: "in_progress" },
      { ...task, id: "two", status: "in_progress" },
    ]),
  ).toBeUndefined()
})
