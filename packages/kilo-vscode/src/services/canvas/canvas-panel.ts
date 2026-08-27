// raya_change - Milestone E sandboxed live canvas webview panel
import { dirname } from "node:path"
import * as vscode from "vscode"
import type { CanvasBuild } from "./canvas-compiler"

type CanvasPanelMessage = { type: "ready" } | { type: "rendered" } | { type: "runtimeError"; error?: string }

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

export class CanvasPanel implements vscode.Disposable {
  static readonly viewType = "raya.CanvasPanel"

  private panel: vscode.WebviewPanel | undefined
  private current: CanvasBuild | undefined
  private settle: ((build: CanvasBuild) => void) | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly runtime: vscode.Uri,
    private readonly extension: vscode.Uri,
  ) {}

  async show(build: CanvasBuild, preserveFocus = true): Promise<CanvasBuild> {
    if (this.settle && this.current) {
      this.resolve({
        ...this.current,
        status: "error",
        error: "Canvas render was superseded by a newer artifact version.",
      })
    }
    this.current = build
    const panel = this.panel ?? this.create(preserveFocus)
    panel.title = `Raya Canvas: ${build.name}`
    panel.reveal(vscode.ViewColumn.Beside, preserveFocus)
    if (build.status === "error" || !build.bundle) {
      panel.webview.html = this.error(build.error ?? "Canvas compilation failed.")
      return build
    }
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extension, vscode.Uri.file(dirname(build.bundle))],
    }
    panel.webview.html = this.html(panel.webview, build.bundle)
    return new Promise<CanvasBuild>((resolve) => {
      this.finish()
      this.settle = resolve
      this.timer = setTimeout(() => {
        this.resolve({
          ...build,
          status: "error",
          error: "Canvas runtime did not report a rendered state within 5 seconds.",
        })
      }, 5_000)
    })
  }

  restore(panel: vscode.WebviewPanel): void {
    this.panel?.dispose()
    this.panel = panel
    this.listen(panel)
    if (!this.current) panel.webview.html = this.error("Re-run or update the canvas to restore its live artifact.")
  }

  dispose(): void {
    if (this.settle && this.current) {
      this.resolve({
        ...this.current,
        status: "error",
        error: "Canvas panel was disposed before rendering completed.",
      })
    } else {
      this.finish()
    }
    this.panel?.dispose()
    this.panel = undefined
  }

  private create(preserveFocus: boolean) {
    const panel = vscode.window.createWebviewPanel(
      CanvasPanel.viewType,
      "Raya Canvas",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extension],
      },
    )
    this.panel = panel
    this.listen(panel)
    return panel
  }

  private listen(panel: vscode.WebviewPanel) {
    panel.webview.onDidReceiveMessage((message: CanvasPanelMessage) => this.receive(message))
    panel.onDidDispose(() => {
      if (this.panel !== panel) return
      this.resolve({
        ...(this.current ?? {
          name: "canvas",
          path: "",
          data: {},
          version: 0,
        }),
        status: "error",
        error: "Canvas panel was closed before rendering completed.",
      })
      this.panel = undefined
    })
  }

  private receive(message: CanvasPanelMessage) {
    if (message.type === "ready") {
      void this.panel?.webview.postMessage({ type: "data", data: this.current?.data ?? {} })
      return
    }
    if (!this.current) return
    if (message.type === "runtimeError") {
      this.resolve({
        ...this.current,
        status: "error",
        error: message.error?.slice(0, 100_000) || "Canvas runtime failed.",
      })
      return
    }
    this.resolve({ ...this.current, status: "ready", error: undefined })
  }

  private resolve(build: CanvasBuild) {
    const settle = this.settle
    this.finish()
    settle?.(build)
  }

  private finish() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.settle = undefined
  }

  private html(webview: vscode.Webview, bundle: string) {
    const runtime = webview.asWebviewUri(this.runtime)
    const artifact = webview.asWebviewUri(vscode.Uri.file(bundle))
    const nonce = crypto.randomUUID().replaceAll("-", "")
    const frame = `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src ${webview.cspSource};">
  <style>
    * { box-sizing: border-box; }
    html, body, #raya-canvas-root { min-width: 100%; min-height: 100%; margin: 0; }
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    #raya-canvas-error { margin: 16px; padding: 12px; overflow: auto; white-space: pre-wrap; color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
  </style>
</head>
<body>
  <div id="raya-canvas-root"></div>
  <pre id="raya-canvas-error" role="alert" hidden></pre>
  <script src="${runtime}"></script>
  <script src="${artifact}"></script>
</body>
</html>`
    return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src 'self';">
  <style>
    * { box-sizing: border-box; }
    html, body, iframe { width: 100%; height: 100%; margin: 0; }
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    iframe { display: block; border: 0; }
  </style>
</head>
<body>
  <iframe id="raya-canvas-frame" title="Raya canvas artifact" sandbox="allow-scripts"></iframe>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById("raya-canvas-frame");
    frame.srcdoc = ${JSON.stringify(frame)};
    window.addEventListener("message", (event) => {
      if (event.source === frame.contentWindow && event.data?.source === "raya-canvas") {
        vscode.postMessage({ type: event.data.type, error: event.data.error });
        return;
      }
      if (event.data?.type !== "data") return;
      frame.contentWindow?.postMessage({ source: "raya-canvas-host", type: "data", data: event.data.data }, "*");
    });
  </script>
</body>
</html>`
  }

  private error(message: string) {
    return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body { margin: 0; padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    pre { padding: 12px; overflow: auto; white-space: pre-wrap; color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
  </style>
</head>
<body>
  <h2>Canvas needs repair</h2>
  <pre role="alert">${escape(message)}</pre>
</body>
</html>`
  }
}
