import { expect, test } from "bun:test"
import { DiagnosticError } from "@/kilocode/diagnostic-error"

test("diagnostic errors expose a stable code and opaque receipt without a private cause", () => {
  const receipt = DiagnosticError.make({
    code: "session.prompt_async.failed",
    message: "Unexpected session failure. Check server logs for details.",
  })
  const serialized = JSON.stringify(receipt.error)

  expect(receipt.error).toEqual({
    name: "UnknownError",
    data: {
      message: "Unexpected session failure. Check server logs for details.",
      code: "session.prompt_async.failed",
      ref: receipt.ref,
    },
  })
  expect(receipt.ref).toMatch(/^err_[0-9a-f-]{8}$/)
  expect(serialized).not.toContain("cause")
  expect(DiagnosticError.make({ code: "session.prompt_async.failed", message: "safe" }).ref).not.toBe(receipt.ref)
})
