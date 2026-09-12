import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as vscode from "vscode"
import { handleEditorAction, openAttachment } from "../../src/kilo-provider/editor-actions"

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

describe("routine attachment open", () => {
  it("rejects mismatched content before writing a preview", () => {
    const write = spyOn(vscode.workspace.fs, "writeFile")
    openAttachment(vscode.Uri.file("/storage"), {
      name: "ledger.pdf",
      mime: "application/pdf",
      size: 2,
      data: "AQ==",
    })
    openAttachment(vscode.Uri.file("/storage"), {
      name: "../ledger.pdf",
      mime: "application/pdf",
      size: 1,
      data: "AQ==",
    })
    openAttachment(vscode.Uri.file("/storage"), {
      name: "ledger.pdf",
      mime: "Application/PDF",
      size: 1,
      data: "AQ==",
    })
    openAttachment(vscode.Uri.file("/storage"), {
      name: "empty.pdf",
      mime: "application/pdf",
      size: 0,
      data: "",
    })
    expect(write).not.toHaveBeenCalled()
    write.mockRestore()
  })

  it("opens valid content and trims stale preview files", async () => {
    const mkdir = spyOn(vscode.workspace.fs, "createDirectory").mockResolvedValue()
    const write = spyOn(vscode.workspace.fs, "writeFile").mockResolvedValue()
    const read = spyOn(vscode.workspace.fs, "readDirectory").mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => [`${index.toString().padStart(2, "0")}.pdf`, vscode.FileType.File]),
    )
    const remove = spyOn(vscode.workspace.fs, "delete").mockResolvedValue()
    const command = spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
    openAttachment(vscode.Uri.file("/storage"), {
      name: "ledger.pdf",
      mime: "application/pdf",
      size: 1,
      data: "AQ==",
    })
    for (let attempt = 0; command.mock.calls.length === 0 && attempt < 50; attempt++) await Bun.sleep(1)
    expect(mkdir).toHaveBeenCalled()
    expect(write).toHaveBeenCalled()
    expect(remove).toHaveBeenCalled()
    expect(command).toHaveBeenCalledWith("vscode.open", expect.anything())
    mkdir.mockRestore()
    write.mockRestore()
    read.mockRestore()
    remove.mockRestore()
    command.mockRestore()
  })
})
