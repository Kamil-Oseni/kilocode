// raya_change - Milestone E sandboxed live canvas webview panel
import { dirname, join } from "node:path"
import * as vscode from "vscode"
import type { CanvasBuild } from "./canvas-compiler"

type CanvasPanelMessage =
  | { type: "ready" }
  | { type: "rendered" }
  | { type: "runtimeError"; error?: string }
  | { type: "captured"; data?: string } // raya_change - run artifact capture
  | { type: "captureError"; error?: string } // raya_change - run artifact capture
  | { type: "designPick"; text?: string } // raya_change - canvas Design Mode

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

export class CanvasPanel implements vscode.Disposable {
  static readonly viewType = "raya.CanvasPanel"

  private panel: vscode.WebviewPanel | undefined
  private current: CanvasBuild | undefined
  private settle: ((build: CanvasBuild) => void) | undefined
  private timer: NodeJS.Timeout | undefined
  // raya_change - Design Mode routes a picked element back to the chat composer.
  private designPick: ((text: string) => void) | undefined

  constructor(
    private readonly runtime: vscode.Uri,
    private readonly extension: vscode.Uri,
  ) {}

  // raya_change - let the extension route Design Mode picks into the chat input.
  onDesignPick(handler: (text: string) => void): void {
    this.designPick = handler
  }

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
    // raya_change start - capture / Design Mode messages are side-channels that
    // must not resolve the render-confirmation promise below.
    if (message.type === "captured") {
      void this.saveCapture(message.data)
      return
    }
    if (message.type === "captureError") {
      void vscode.window.showErrorMessage(`Raya: canvas capture failed — ${message.error ?? "unknown error"}`)
      return
    }
    if (message.type === "designPick") {
      if (message.text) this.designPick?.(message.text)
      return
    }
    // raya_change end
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

  // raya_change - persist a PNG snapshot of the live canvas next to its source
  // (.raya/canvases/captures/) so a finished run has a verifiable artifact.
  private async saveCapture(dataUrl?: string) {
    const source = this.current?.path
    if (!dataUrl || !source) {
      void vscode.window.showErrorMessage("Raya: nothing to capture yet — render a canvas first.")
      return
    }
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl)
    if (!match) {
      void vscode.window.showErrorMessage("Raya: unsupported capture format.")
      return
    }
    const dir = join(dirname(source), "captures")
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
    const file = join(dir, `${this.current?.name ?? "canvas"}-${stamp}.png`)
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir))
      await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(match[1], "base64"))
    } catch (err) {
      console.error("[Raya] canvas capture save failed:", err)
      void vscode.window.showErrorMessage("Raya: could not save the canvas capture.")
      return
    }
    const open = "Open"
    const choice = await vscode.window.showInformationMessage(`Canvas captured: ${file}`, open)
    if (choice === open) void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file))
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
    // Escape every less-than char as \u003c so a closing script tag inside the embedded
    // document cannot end this outer inline script early (JSON.stringify escapes quotes
    // but not markup). The JS engine decodes \u003c back at runtime, so srcdoc still gets
    // valid HTML.
    const src = JSON.stringify(frame).replaceAll("<", "\\u003c")
    const bridge = `
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById("raya-canvas-frame");
    frame.srcdoc = ${src};
    const toInner = (message) => frame.contentWindow?.postMessage({ source: "raya-canvas-host", ...message }, "*");
    let design = false;
    const designBtn = document.getElementById("raya-design");
    const captureBtn = document.getElementById("raya-capture");
    designBtn.addEventListener("click", () => {
      design = !design;
      designBtn.classList.toggle("active", design);
      toInner({ type: "designMode", enabled: design });
    });
    captureBtn.addEventListener("click", () => toInner({ type: "capture" }));
    window.addEventListener("message", (event) => {
      if (event.source === frame.contentWindow && event.data?.source === "raya-canvas") {
        vscode.postMessage({ type: event.data.type, error: event.data.error, data: event.data.data, text: event.data.text });
        return;
      }
      if (event.data?.type !== "data") return;
      toInner({ type: "data", data: event.data.data });
    });
`
    // A raw closing-script sequence anywhere in this hand-written bridge would let the
    // HTML parser end the inline script early and dump the rest as visible text (this bug
    // has bitten twice, once from a comment). src is already escaped; fail loudly if any
    // future edit reintroduces a literal tag terminator.
    if (bridge.includes("\u003c/")) throw new Error("canvas bridge contains a raw closing tag; escape it as \\u003c")
    return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src 'self';">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body { display: flex; flex-direction: column; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    #raya-canvas-bar { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex: 0 0 auto; }
    #raya-canvas-bar button { font: inherit; font-size: 12px; line-height: 1.6; padding: 1px 10px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; border-radius: 4px; cursor: pointer; }
    #raya-canvas-bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #raya-canvas-bar button.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    iframe { display: block; border: 0; flex: 1 1 auto; width: 100%; }
  </style>
</head>
<body>
  <header id="raya-canvas-bar">
    <button id="raya-design" type="button" title="Highlight and pick an element to steer the agent">Design Mode</button>
    <button id="raya-capture" type="button" title="Save a PNG snapshot of this canvas">Capture</button>
  </header>
  <iframe id="raya-canvas-frame" title="Raya canvas artifact" sandbox="allow-scripts"></iframe>
  <script nonce="${nonce}">${bridge}</script>
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
