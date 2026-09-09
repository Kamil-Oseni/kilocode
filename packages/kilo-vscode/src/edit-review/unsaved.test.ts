import { afterEach, describe, expect, test } from "bun:test"
import * as path from "node:path"
import * as vscode from "vscode"
import { assertSaved, UnsavedReview, failure } from "./unsaved"

const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
afterEach(() => {
  documents.length = 0
})

describe("review buffer protection", () => {
  test("preserves actionable backend review conflicts without exposing arbitrary errors", () => {
    expect(failure({ _tag: "ReviewConflict", message: "The previous review outcome is uncertain." }, "Failed")).toBe("The previous review outcome is uncertain.")
    expect(failure({ message: "Internal detail" }, "Failed")).toBe("Failed")
  })

  test("blocks selected dirty files using relative and absolute paths", () => {
    const file = path.resolve("src/file.ts")
    const document = { uri: vscode.Uri.file(file), isDirty: true }
    documents.push(document as vscode.TextDocument)
    expect(() => assertSaved(process.cwd(), ["src/file.ts"])).toThrow(UnsavedReview)
    expect(() => assertSaved(process.cwd(), [file])).toThrow("Save or revert unsaved changes")
    if (process.platform === "win32")
      expect(() => assertSaved(process.cwd(), [file.toUpperCase()])).toThrow(UnsavedReview)
    document.isDirty = false
    expect(() => assertSaved(process.cwd(), [file])).not.toThrow()
  })

  test("does not block unrelated files, saved files, or virtual documents", () => {
    documents.push(
      { uri: vscode.Uri.file(path.resolve("other/file.ts")), isDirty: true } as vscode.TextDocument,
      { uri: vscode.Uri.file(path.resolve("src/file.ts")), isDirty: false } as vscode.TextDocument,
      { uri: { scheme: "untitled", fsPath: path.resolve("src/file.ts") }, isDirty: true } as vscode.TextDocument,
    )
    expect(() => assertSaved(process.cwd(), ["src/file.ts"])).not.toThrow()
  })

  test("legacy bulk review checks its directory without matching sibling prefixes", () => {
    const root = path.resolve("project")
    documents.push({
      uri: vscode.Uri.file(path.resolve("project-other/file.ts")),
      isDirty: true,
    } as vscode.TextDocument)
    expect(() => assertSaved(root)).not.toThrow()
    documents.push({ uri: vscode.Uri.file(path.join(root, "file.ts")), isDirty: true } as vscode.TextDocument)
    expect(() => assertSaved(root)).toThrow(UnsavedReview)
  })
})
