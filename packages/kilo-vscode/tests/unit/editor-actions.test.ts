import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as vscode from "vscode"
import { handleEditorAction } from "../../src/kilo-provider/editor-actions"

const open = spyOn(vscode.workspace, "openTextDocument")
const warn = spyOn(vscode.window, "showWarningMessage")
const find = spyOn(vscode.workspace, "findFiles")

afterEach(() => {
  open.mockClear()
  warn.mockClear()
  find.mockClear()
})

describe("openFile review ghost", () => {
  it("opens a virtual review buffer when the reviewed file is gone", async () => {
    const stat = spyOn(vscode.workspace.fs, "stat").mockRejectedValue(new Error("ENOENT"))
    const ghost = vscode.Uri.from({ scheme: "raya-review", path: "/gone.ts", query: "abc" })
    const calls: unknown[][] = []
    handleEditorAction(
      { type: "openFile", filePath: "gone.ts", sessionID: "session-a" },
      {
        dir: () => "/repo",
        ghost: (...args) => {
          calls.push(args)
          return ghost
        },
      },
    )
    for (let attempt = 0; open.mock.calls.length === 0 && attempt < 50; attempt++) await Bun.sleep(1)
    expect(open).toHaveBeenCalledWith(ghost)
    expect(find).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(calls).toEqual([["gone.ts", "/repo", "session-a"]])
    stat.mockRestore()
  })

  it("still searches the session folder when the path is not under review", async () => {
    const stat = spyOn(vscode.workspace.fs, "stat").mockRejectedValue(new Error("ENOENT"))
    find.mockResolvedValue([])
    handleEditorAction({ type: "openFile", filePath: "gone.ts" }, { dir: () => "/repo" })
    for (let attempt = 0; warn.mock.calls.length === 0 && attempt < 50; attempt++) await Bun.sleep(1)
    expect(open).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith("File not found: gone.ts")
    stat.mockRestore()
  })
})
