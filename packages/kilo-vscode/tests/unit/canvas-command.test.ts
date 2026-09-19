import { expect, mock, spyOn, test } from "bun:test"
import * as vscode from "vscode"
import { registerCanvasCommand } from "../../src/services/canvas/canvas-command"
import type { CanvasService } from "../../src/services/canvas/canvas-service"

type Handler = (value?: unknown) => Promise<unknown>

function register(open = mock(async () => ({ status: "ready" }))) {
  let handler: Handler = async () => undefined
  const command = spyOn(vscode.commands, "registerCommand").mockImplementation(((id: string, next: Handler) => {
    expect(id).toBe("raya.openCanvas")
    handler = next
    return { dispose() {} }
  }) as typeof vscode.commands.registerCommand)
  const service = { open } as unknown as CanvasService
  const disposable = registerCanvasCommand(service)
  return { command, disposable, handler, open }
}

test("saved Canvas command discovers and sorts workspace canvases", async () => {
  const folders = [
    { name: "Second", uri: vscode.Uri.file("/second") },
    { name: "First", uri: vscode.Uri.file("/first") },
  ] as vscode.WorkspaceFolder[]
  const original = vscode.workspace.workspaceFolders
  Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: folders })
  const read = spyOn(vscode.workspace.fs, "readDirectory").mockImplementation(async (uri) => {
    if (uri.fsPath.startsWith("/second")) {
      return [
        ["zeta.canvas.tsx", vscode.FileType.File],
        ["ignore.json", vscode.FileType.File],
      ]
    }
    return [["alpha.canvas.tsx", vscode.FileType.File]]
  })
  const pick = spyOn(vscode.window, "showQuickPick").mockImplementation(async (items) => (await items)[1] as never)
  const state = register()
  try {
    const result = await state.handler()
    expect(pick).toHaveBeenCalledWith(
      [
        expect.objectContaining({ label: "alpha", description: "First", root: "/first", name: "alpha" }),
        expect.objectContaining({ label: "zeta", description: "Second", root: "/second", name: "zeta" }),
      ],
      {
        placeHolder: "Choose a saved canvas to reopen",
        matchOnDescription: true,
        matchOnDetail: true,
      },
    )
    expect(state.open).toHaveBeenCalledWith("/second", "zeta")
    expect(result).toEqual({ status: "ready" })
  } finally {
    state.disposable.dispose()
    state.command.mockRestore()
    pick.mockRestore()
    read.mockRestore()
    Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: original })
  }
})

test("saved Canvas command accepts a direct recovery target", async () => {
  const pick = spyOn(vscode.window, "showQuickPick")
  const read = spyOn(vscode.workspace.fs, "readDirectory")
  const state = register()
  try {
    await state.handler({ root: "/repo", name: "report" })
    expect(state.open).toHaveBeenCalledWith("/repo", "report")
    expect(read).not.toHaveBeenCalled()
    expect(pick).not.toHaveBeenCalled()
  } finally {
    state.disposable.dispose()
    state.command.mockRestore()
    pick.mockRestore()
    read.mockRestore()
  }
})

test("saved Canvas command explains empty and failed recovery states", async () => {
  const info = spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined)
  const error = spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)
  const log = spyOn(console, "error").mockImplementation(() => undefined)
  const read = spyOn(vscode.workspace.fs, "readDirectory").mockResolvedValue([])
  const empty = register()
  try {
    await empty.handler()
    expect(info).toHaveBeenCalledWith("No saved canvases were found in the open workspace.")
    expect(empty.open).not.toHaveBeenCalled()
  } finally {
    empty.disposable.dispose()
    empty.command.mockRestore()
  }

  const open = mock(async () => {
    throw new Error("Both saved copies are damaged.")
  })
  const failed = register(open)
  try {
    expect(await failed.handler({ root: "/repo", name: "report" })).toBeUndefined()
    expect(error).toHaveBeenCalledWith(
      "Canvas couldn't reopen. Your saved files are still available. Both saved copies are damaged.",
    )
    expect(log).toHaveBeenCalledWith(
      "[Kilo New] [Raya] Could not open saved canvas report:",
      expect.objectContaining({ message: "Both saved copies are damaged." }),
    )
  } finally {
    failed.disposable.dispose()
    failed.command.mockRestore()
    read.mockRestore()
    info.mockRestore()
    error.mockRestore()
    log.mockRestore()
  }
})
