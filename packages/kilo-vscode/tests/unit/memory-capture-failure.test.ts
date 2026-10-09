import { expect, test } from "bun:test"
import { CaptureFailure, failure } from "../../src/second-brain/capture-failure"
import { Failure } from "../../src/second-brain/client"

test("capture diagnostics retain bounded stages and closed causes without private error text", () => {
  const secret = new Error("Private note and credential text must never enter diagnostics")
  const err = new CaptureFailure(
    "publication",
    new AggregateError([
      new Failure("identity_mismatch", "Private source", 200),
      new Error("Original Memory setup or debt changed before settlement"),
      secret,
      ...Array.from({ length: 20 }, () => new Error("Private source")),
    ]),
  )
  const result = failure(err)
  expect(result.stage).toBe("publication")
  expect(result.errors.slice(0, 3)).toEqual(["identity_mismatch", "settlement_changed", "unclassified"])
  expect(result.errors).toHaveLength(8)
  expect(JSON.stringify(result)).not.toContain("Private")
  expect(
    new CaptureFailure("authorization", Object.assign(new Error("Private"), { code: "capture_source_capacity" })).code,
  ).toBe("capture_source_capacity")
  expect(failure(new Error("Original indexed capture receipt differs"))).toEqual({
    stage: "confirmation",
    errors: ["receipt_changed"],
  })
})
