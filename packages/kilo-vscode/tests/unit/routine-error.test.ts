import { expect, test } from "bun:test"
import { recovery } from "../../src/shared/routine-error"

test("uses explicit backend causes and preserves the affected field", () => {
  expect(recovery({ kind: "schedule", field: "timezone" })).toMatchObject({ kind: "schedule", field: "timezone" })
  expect(recovery({ data: { kind: "capability", field: "capabilities" } })).toMatchObject({ kind: "capability" })
  expect(recovery({ kind: "conflict" })?.next).toContain("compare it with your draft")
  expect(recovery({ kind: "paused" })?.next).toContain("before resuming")
})

test("connection errors remain uncertain and never imply a safe replay", () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"])
    expect(recovery(new Error("Transport failed", { cause: { code } }))).toMatchObject({
      kind: "connection",
      next: expect.stringContaining("may have reached the backend"),
    })
})

test("does not guess a cause from HTTP status, message text, unknown kinds or circular data", () => {
  for (const error of [null, "Bad Request", { status: 400 }, { message: "money" }, { kind: "future" }])
    expect(recovery(error)).toBeUndefined()
  const error: { cause?: unknown } = {}
  error.cause = error
  expect(recovery(error)).toBeUndefined()
})
