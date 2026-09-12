import { describe, expect, test } from "bun:test"
import { note, targets } from "../../webview-ui/src/components/chat/review-files"

describe("chat review file targets", () => {
  test("edit and write use the live filediff path and status", () => {
    expect(targets("edit", { filePath: "src/a.ts" }, { filediff: { file: "src/a.ts", status: "deleted" } })).toEqual([
      { file: "src/a.ts", kind: "deleted" },
    ])
    expect(targets("write", { filePath: "src/b.ts" }, {})).toEqual([{ file: "src/b.ts", kind: "modified" }])
  })

  test("apply_patch keeps deleted and renamed files reviewable", () => {
    expect(
      targets(
        "apply_patch",
        {},
        {
          files: [
            { filePath: "/repo/gone.ts", relativePath: "gone.ts", type: "delete" },
            { filePath: "/repo/old.ts", relativePath: "src/new.ts", movePath: "/repo/src/new.ts", type: "move" },
            { filePath: "/repo/src/a.ts", relativePath: "src/a.ts", type: "update" },
            { filePath: "/repo/src/a.ts", relativePath: "src/a.ts", type: "update" },
          ],
        },
      ),
    ).toEqual([
      { file: "gone.ts", kind: "deleted" },
      { file: "src/new.ts", kind: "renamed" },
      { file: "src/a.ts", kind: "modified" },
    ])
    expect(note("deleted")).toBe("Deleted file")
    expect(note("renamed")).toBe("Renamed file")
    expect(note("modified")).toBeUndefined()
  })

  test("multiedit keeps every nested filediff", () => {
    expect(
      targets(
        "multiedit",
        {},
        {
          results: [{ filediff: { file: "one.ts", status: "added" } }, { filediff: { file: "two.ts" } }],
        },
      ),
    ).toEqual([
      { file: "one.ts", kind: "added" },
      { file: "two.ts", kind: "modified" },
    ])
  })
})
