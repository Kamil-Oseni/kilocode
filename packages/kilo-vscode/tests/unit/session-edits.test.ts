import { describe, expect, it } from "bun:test"
import * as path from "node:path" // raya_change
import { editPaths } from "../../src/kilo-provider/session-edits"

describe("session edit paths", () => {
  it("ignores read tools and returns every file from mutating tools", () => {
    const parts = [
      {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "/workspace/app/vendor/readme.md" } },
      },
      {
        type: "tool",
        tool: "edit",
        state: { status: "completed", metadata: { filediff: { file: "/workspace/app/src/a.ts" } } },
      },
      {
        type: "tool",
        tool: "apply_patch",
        state: {
          status: "completed",
          metadata: {
            files: [
              { filePath: "/workspace/app/src/b.ts" },
              { filePath: "/workspace/app/src/old.ts", movePath: "/workspace/app/src/new.ts" },
            ],
          },
        },
      },
    ]

    // raya_change start - editPaths intentionally returns host-normalized absolute paths.
    expect(editPaths(parts, "/workspace")).toEqual(
      ["/workspace/app/src/a.ts", "/workspace/app/src/b.ts", "/workspace/app/src/new.ts"].map((file) =>
        path.normalize(file),
      ),
    )
    // raya_change end
  })
})
