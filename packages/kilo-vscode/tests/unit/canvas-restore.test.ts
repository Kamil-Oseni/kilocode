import { afterAll, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as vscode from "vscode"
import { stop } from "esbuild-wasm"
import { CanvasCompiler } from "../../src/services/canvas/canvas-compiler"
import { CanvasService } from "../../src/services/canvas/canvas-service"

afterAll(stop)

test.each(["clean", "dirty", "both-fail", "divergent"])("extension restoration handles %s recovery", async (mode) => {
  const dirty = mode === "dirty"
  const root = await mkdtemp(join(tmpdir(), "raya-restore-"))
  const output = join(root, "canvas-bundles")
  const compiler = new CanvasCompiler(output)
  const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
  const document = { isDirty: dirty, uri: vscode.Uri.file(compiler.source(root, "report")) } as vscode.TextDocument
  documents.push(document)
  const service = new CanvasService(
    {
      onEvent: () => () => undefined,
      onStateChange: () => () => undefined,
      getKnownDirectories: () => [],
      getClient: () => {
        throw new Error("Unexpected backend access during canvas restore")
      },
    },
    {
      globalStorageUri: vscode.Uri.file(root),
      extensionUri: vscode.Uri.file(root),
    } as vscode.ExtensionContext,
  )
  const notice = spyOn(vscode.window, "showWarningMessage").mockResolvedValue(
    (mode === "both-fail" ? "Dismiss" : "Keep previous version") as never,
  )
  let receive: (message: unknown) => void = () => undefined
  let html = ""
  let renders = 0
  const panel = {
    title: "Canvas",
    reveal() {},
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
      get html() {
        return html
      },
      set html(value: string) {
        html = value
        const match = /token: ("[^"]+")/.exec(value)
        if (!match) return
        const token = JSON.parse(match[1]!)
        renders++
        const type = mode !== "divergent" && (renders === 1 || mode === "both-fail") ? "runtimeError" : "rendered"
        queueMicrotask(() => receive({ token, type, error: "Saved artifact failed on reopen" }))
      },
    },
  }
  try {
    const first = await compiler.create(root, "report", "export default function Report() { return <p>Earlier</p> }", {
      value: 1,
    })
    await compiler.commit(first)
    const next = await compiler.create(root, "report", "export default function Report() { return <p>Later</p> }", {
      value: 2,
    })
    await compiler.commit(next)
    if (mode === "divergent") await writeFile(compiler.data(root, "report"), JSON.stringify({ value: 99 }))
    await service.restore(panel as unknown as vscode.WebviewPanel, { root, name: "report" })
    if (mode === "divergent") {
      expect(renders).toBe(1)
      expect(service.panel.owns(next)).toBe(true)
      expect(notice).toHaveBeenCalledWith(expect.stringContaining("differs from its editable source/data files"))
      expect(JSON.parse(await readFile(compiler.data(root, "report"), "utf8"))).toEqual({ value: 99 })
      return
    }
    expect(renders).toBe(2)
    expect(service.panel.owns(first)).toBe(true)
    expect((await new CanvasCompiler(output).restore(root, "report"))?.revision).toBe(first.revision)
    expect((await compiler.draft(next)).data).toEqual({ value: 2 })
    expect(await readFile(next.path, "utf8")).toContain(dirty ? "Later" : "Earlier")
    expect(JSON.parse(await readFile(compiler.data(root, "report"), "utf8"))).toEqual({ value: dirty ? 2 : 1 })
    if (dirty) expect(notice.mock.calls[0]?.[0]).toContain("Edited source/data files were retained")
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining("Saved artifact failed on reopen"),
      mode === "both-fail" ? "Dismiss" : "Keep previous version",
      "Inspect draft",
      "Retry",
    )
    expect(notice).toHaveBeenCalledTimes(1)
    if (mode === "both-fail") expect(notice.mock.calls[0]?.[0]).toContain("The earlier saved version also failed")
  } finally {
    service.dispose()
    documents.splice(documents.indexOf(document), 1)
    notice.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
