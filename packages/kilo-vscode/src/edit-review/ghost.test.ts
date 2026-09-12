import { describe, expect, test } from "bun:test"
import * as vscode from "vscode"
import { decode, prior, SCHEME, uri } from "./ghost"

describe("ghost review buffers", () => {
  test("reconstructs deleted file text from the old side of the patch", () => {
    expect(prior("@@ -1,2 +0,0 @@\n-old\n-lines")).toBe("old\nlines")
    expect(prior("diff --git a/old.ts b/file.ts\nrename from old.ts\nrename to file.ts")).toBe("")
    expect(prior("@@ -2,3 +2,2 @@\n keep\n-gone\n keep")).toBe("keep\ngone\nkeep")
  })

  test("round-trips the absolute review identity through the virtual uri", () => {
    const abs = "C:\\repo\\gone.ts"
    const doc = uri(abs, "src/gone.ts")
    expect(doc.scheme).toBe(SCHEME)
    expect(doc.path).toBe("/src/gone.ts")
    expect(decode(doc)).toBe(abs)
    expect(decode({ scheme: "file", query: "", path: "/src/gone.ts" } as vscode.Uri)).toBeUndefined()
  })
})
