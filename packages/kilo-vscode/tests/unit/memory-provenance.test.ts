import { expect, test } from "bun:test"
import { provenance } from "../../src/shared/memory-provenance"

const part = (value: unknown) => ({
  type: "text",
  text: "",
  synthetic: true,
  ignored: true,
  metadata: { kiloMemory: value },
})
const receipt = { type: "startup", count: 3, tokens: 120, files: ["project.md", "environment.md"] }

test("memory provenance preserves recorded scope and time without exposing content", () => {
  const result = provenance(
    part({
      ...receipt,
      captured: 42,
      scope: { directory: "/worktree", project: "/project" },
      items: ["SECRET RECALL CONTENT"],
      text: "FULL PROMPT",
      extra: "private",
    }),
  )
  expect(result).toEqual({
    type: "startup",
    count: 3,
    tokens: 120,
    files: ["project.md", "environment.md"],
    captured: 42,
    directory: "/worktree",
    project: "/project",
    truncated: false,
  })
  expect(JSON.stringify(result)).not.toContain("SECRET")
  expect(JSON.stringify(result)).not.toContain("FULL PROMPT")
  expect(provenance(part({ type: "recall", count: 1, tokens: 10, sources: ["corrections.md"] }))).toMatchObject({
    type: "recall",
    files: ["corrections.md"],
    captured: undefined,
    directory: undefined,
    project: undefined,
  })
  expect(provenance(part({ type: "startup", tokens: 3, sources: ["project.md"] }))).toMatchObject({
    count: undefined,
    tokens: 3,
    files: ["project.md"],
  })
  expect(provenance(part({ type: "startup", sources: ["project.md"] }))).toMatchObject({
    count: undefined,
    tokens: undefined,
  })
})

test("memory provenance rejects unknown or malformed receipts and preserves unknown legacy facts", () => {
  for (const value of [
    null,
    [],
    {},
    { ...receipt, type: "future" },
    { ...receipt, count: -1 },
    { ...receipt, tokens: Infinity },
    { ...receipt, count: 1.5 },
    { ...receipt, tokens: "120" },
  ]) {
    expect(provenance(part(value))).toBeUndefined()
  }
  expect(provenance({ type: "tool", metadata: { kiloMemory: receipt } })).toBeUndefined()
  for (const update of [{ text: "Ordinary answer" }, { synthetic: false }, { ignored: false }, { text: " " }]) {
    expect(provenance({ ...part(receipt), ...update })).toBeUndefined()
  }
  for (const captured of [-1, Infinity, NaN, 1.5, "today", 8_640_000_000_000_001]) {
    expect(provenance(part({ ...receipt, captured }))?.captured).toBeUndefined()
  }
  for (const scope of [
    null,
    [],
    { directory: "/worktree" },
    { directory: "", project: "/project" },
    { directory: "/worktree", project: "x".repeat(4097) },
  ]) {
    expect(provenance(part({ ...receipt, scope }))).toMatchObject({ directory: undefined, project: undefined })
  }
})

test("memory source display is bounded and does not create path actions", () => {
  const result = provenance(
    part({
      ...receipt,
      files: ["x".repeat(1000), "javascript:alert(1)", "<img src=x>", "project.md", "project.md", "hidden.md"],
      scope: { directory: "a".repeat(1000), project: "b".repeat(1000) },
    }),
  )
  expect(result?.files).toHaveLength(4)
  expect(result?.files[0]).toHaveLength(163)
  expect(result?.files).not.toContain("hidden.md")
  expect(result?.truncated).toBe(true)
  expect(result?.directory).toHaveLength(403)
  expect(result?.project).toHaveLength(403)
  expect(result).not.toHaveProperty("href")
})
