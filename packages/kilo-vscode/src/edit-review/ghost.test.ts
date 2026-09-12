import { describe, expect, test } from "bun:test"
import * as vscode from "vscode"
import { decode, SCHEME, UNAVAILABLE, uri } from "./ghost"

describe("ghost review buffers", () => {
  test("provides an honest fallback when authoritative content is unavailable", () => {
    expect(UNAVAILABLE).toContain("does not contain the original text")
  })

  test("round-trips an opaque registry id without exposing an absolute path", () => {
    const id = "0115ccad-2a86-4b8d-b7d2-23e38df94067"
    const doc = uri(id, "src/gone.ts")
    expect(doc.scheme).toBe(SCHEME)
    expect(doc.path).toBe("/src/gone.ts")
    expect(doc.toString()).not.toContain("repo")
    expect(decode(doc)).toBe(id)
    expect(decode({ scheme: "file", query: "", path: "/src/gone.ts" } as vscode.Uri)).toBeUndefined()
  })
})
