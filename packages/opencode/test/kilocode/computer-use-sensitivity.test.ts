// raya_change - deterministic sensitive target classification tests
import { describe, expect, test } from "bun:test"
import { infer, mismatch } from "@/kilocode/computer-use/sensitivity"

describe("Computer Use semantic sensitivity", () => {
  test("classifies trustworthy accessible target names", () => {
    expect(infer({ kind: "role", role: "button", name: "Send message" })).toBe("communications")
    expect(infer({ kind: "role", role: "button", name: "Pay invoice" })).toBe("financial")
    expect(infer({ kind: "label", text: "Password" })).toBe("credentials")
    expect(infer({ kind: "role", role: "button", name: "Install update" })).toBe("software")
    expect(infer({ kind: "role", role: "button", name: "Open security settings" })).toBe("system")
    expect(infer({ kind: "role", role: "button", name: "Delete account" })).toBe("deletion")
    expect(infer({ kind: "role", role: "button", name: "Upload records" })).toBe("disclosure")
    expect(infer({ kind: "role", role: "button", name: "Accept terms" })).toBe("legal")
    expect(infer({ kind: "role", role: "button", name: "Publish website" })).toBe("publishing")
  })

  test("does not infer from opaque or untrusted selector strings", () => {
    expect(infer("#send-payment")).toBeUndefined()
    expect(infer({ kind: "testid", value: "delete-account" })).toBeUndefined()
    expect(infer({ kind: "role", role: "button", name: "Continue" })).toBeUndefined()
  })

  test("refuses ordinary or mismatched declarations for inferred sensitive targets", () => {
    expect(mismatch("ordinary", "financial")).toBe("Accessible target semantics require sensitive_category=financial")
    expect(mismatch("communications", "financial")).toBe(
      "Accessible target semantics require sensitive_category=financial",
    )
    expect(mismatch("financial", "financial")).toBeUndefined()
    expect(mismatch("ordinary", undefined)).toBeUndefined()
  })
})
