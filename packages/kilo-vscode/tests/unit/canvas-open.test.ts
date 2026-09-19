import { afterAll, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as vscode from "vscode"
import { stop } from "esbuild-wasm"
import { CanvasCompiler } from "../../src/services/canvas/canvas-compiler"
import { CanvasService } from "../../src/services/canvas/canvas-service"

afterAll(stop)

test("open restores a committed Canvas without a serialized editor tab", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-open-"))
  const storage = join(root, "storage")
  await mkdir(join(root, "dist"), { recursive: true })
  await writeFile(join(root, "dist", "canvas-runtime.js"), "window.RayaCanvas = {}")
  const compiler = new CanvasCompiler(join(storage, "canvas-bundles"))
  const build = await compiler.create(root, "report", "export default function Report() { return <p>Saved</p> }", {
    value: 1,
  })
  await compiler.commit(build)

  let receive: (message: unknown) => void = () => undefined
  let focus: boolean | undefined
  const panel = {
    title: "Canvas",
    reveal: (_column: vscode.ViewColumn, preserveFocus: boolean) => {
      focus = preserveFocus
    },
    dispose() {},
    onDidDispose() {},
    webview: {
      options: {},
      cspSource: "https://canvas.test",
      asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: async () => true,
      onDidReceiveMessage: (handler: typeof receive) => {
        receive = handler
      },
      set html(value: string) {
        const match = /token: ("[^"]+")/.exec(value)
        if (!match) return
        const token = JSON.parse(match[1]!)
        queueMicrotask(() => receive({ token, type: "rendered" }))
      },
    },
  }
  const create = spyOn(vscode.window, "createWebviewPanel").mockReturnValue(panel as unknown as vscode.WebviewPanel)
  const service = new CanvasService(
    {
      onEvent: () => () => undefined,
      onStateChange: () => () => undefined,
      getKnownDirectories: () => [],
      getClient: () => {
        throw new Error("Unexpected backend access during Canvas reopen")
      },
    },
    {
      globalStorageUri: vscode.Uri.file(storage),
      extensionUri: vscode.Uri.file(root),
    } as vscode.ExtensionContext,
  )
  try {
    const reopened = await service.open(root, "report")
    expect(reopened.status).toBe("ready")
    expect(reopened.revision).toBe(build.revision)
    expect(service.panel.owns(build)).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect(focus).toBe(false)
  } finally {
    service.dispose()
    create.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
