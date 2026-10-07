import { expect, test } from "bun:test"
import { MemoryRedact } from "../src/capture/redact"
import { MemoryOperations } from "../src/capture/operations"
import { errorReason } from "../src/capture/outcome"
import { salvageTyped } from "../src/capture/parse"

test("bare model-download and fine-grained GitHub tokens cannot become memory or diagnostic text", () => {
  for (const token of ["hf_" + "a".repeat(34), "github_pat_" + "A1_".repeat(28)]) {
    expect(MemoryRedact.has(token)).toBe(true)
    expect(MemoryRedact.text(`Signed in with ${token}.`)).toBe("Signed in with [redacted].")
    expect(MemoryOperations.secret({ action: "add", key: "login", text: token })).toBe(true)
    expect(MemoryOperations.secret({ action: "add", key: token, text: "Login succeeded." })).toBe(true)
    expect(errorReason(new Error(`Download failed for ${token}`))).not.toContain(token)
    const parsed = salvageTyped(JSON.stringify({ operations: [], skipped: [{ reason: "unsupported", text: token }] }))
    expect(parsed.skipped[0]?.text).toBe("[redacted]")
  }
})

test("ordinary download preferences and token-prefix documentation remain usable", () => {
  for (const text of [
    "Download the model from Hugging Face.",
    "GitHub fine-grained tokens begin with github_pat_.",
    "The prefix is hf_.",
  ]) {
    expect(MemoryRedact.has(text)).toBe(false)
    expect(MemoryRedact.text(text)).toBe(text)
  }
})
