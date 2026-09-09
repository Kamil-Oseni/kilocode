import { expect, test } from "bun:test"
import * as vscode from "vscode"
import { CanvasPanel } from "../../src/services/canvas/canvas-panel"
import type { CanvasBuild } from "../../src/services/canvas/canvas-compiler"

test("only the current canvas render can acknowledge its candidate", async () => {
  const messages: unknown[] = []
  let receive: (message: unknown) => void = () => {}
  const panel = {
    title: "Canvas",
    reveal() {},
    dispose() {},
    onDidDispose() {},
    webview: {
      html: "",
      options: {},
      cspSource: "https://canvas.test",
      asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: async (message: unknown) => {
        messages.push(message)
        return true
      },
      onDidReceiveMessage: (handler: typeof receive) => {
        receive = handler
      },
    },
  }
  const view = new CanvasPanel(vscode.Uri.file("runtime.js"), vscode.Uri.file("extension"))
  const failures: CanvasBuild[] = []
  view.onFailure((build) => failures.push(build))
  view.restore(panel as unknown as vscode.WebviewPanel)
  const build: CanvasBuild = {
    name: "report",
    path: "C:/workspace/.raya/canvases/report.canvas.tsx",
    bundle: "C:/bundles/report.js",
    data: { value: 1 },
    status: "ready",
    version: 1,
    revision: "first",
  }
  const token = () => JSON.parse(/token: ("[^"]+")/.exec(panel.webview.html)![1]) as string
  try {
    const first = view.show(build)
    const old = token()
    const next = { ...build, version: 2, revision: "next", data: { value: 2 } }
    let done = false
    const second = view.show(next).then((result) => {
      done = true
      return result
    })
    const current = token()
    expect((await first).status).toBe("error")
    receive({ type: "ready", token: old })
    receive({ type: "rendered", token: old })
    receive({ type: "unexpected", token: current })
    await Promise.resolve()
    expect(messages).toEqual([])
    expect(done).toBe(false)
    receive({ type: "ready", token: current })
    expect(messages).toEqual([{ type: "data", data: { value: 2 } }])
    receive({ type: "rendered", token: current })
    expect((await second).revision).toBe("next")
    receive({ type: "runtimeError", token: old, error: "stale failure" })
    expect(failures).toEqual([])
    receive({ type: "runtimeError", token: current, error: "interaction failed" })
    receive({ type: "runtimeError", token: current, error: "duplicate failure" })
    receive({ type: "rendered", token: current })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ revision: "next", status: "error", error: "interaction failed" })

    const third = view.show({ ...next, revision: "third" })
    const pending = token()
    receive({ type: "runtimeError", token: pending, error: "initial render failed" })
    expect((await third).error).toBe("initial render failed")
    expect(failures).toHaveLength(1)

    const fourth = view.show({ ...next, revision: "fourth" })
    const last = token()
    receive({ type: "rendered", token: last })
    await fourth
    view.dispose()
    receive({ type: "runtimeError", token: last, error: "closed panel" })
    expect(failures).toHaveLength(1)
  } finally {
    view.dispose()
  }
})
