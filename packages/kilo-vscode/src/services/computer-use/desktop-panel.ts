import * as vscode from "vscode"
import { randomUUID } from "node:crypto"
import { DesktopSession, type DesktopState } from "./desktop-session"

type Message = { type: "ready" | "refresh" | "takeover" | "resume" }

export class DesktopPanel implements vscode.Disposable {
  static readonly viewType = "raya.DesktopPanel"

  private panel: vscode.WebviewPanel | undefined
  private off: (() => void) | undefined

  constructor(private readonly session: DesktopSession) {}

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside)
      return
    }
    const panel = vscode.window.createWebviewPanel(
      DesktopPanel.viewType,
      "Raya Computer Use",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    this.panel = panel
    panel.webview.html = this.html()
    panel.webview.onDidReceiveMessage((message: Message) => void this.receive(message))
    panel.onDidDispose(() => {
      this.off?.()
      this.off = undefined
      this.panel = undefined
      this.session.takeControl("Computer Use preview closed. Agent desktop control is paused.")
    })
    this.off = this.session.onState((state) => void this.state(state))
  }

  dispose(): void {
    this.off?.()
    this.off = undefined
    this.panel?.dispose()
    this.panel = undefined
  }

  private async receive(message: Message): Promise<void> {
    if (message.type === "takeover") {
      this.session.takeControl()
      return
    }
    if (message.type === "resume") this.session.resume()
    if (!["ready", "refresh", "resume"].includes(message.type)) return
    await this.capture()
  }

  private async capture(): Promise<void> {
    await this.panel?.webview.postMessage({ type: "loading" })
    try {
      const frame = await this.session.observe()
      await this.panel?.webview.postMessage({
        type: "frame",
        src: `data:${frame.mime};base64,${frame.data}`,
        width: frame.width,
        height: frame.height,
        observedAt: frame.observation.observedAt,
      })
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private state(state: DesktopState): void {
    void this.panel?.webview.postMessage({ type: "state", ...state })
  }

  private html(): string {
    const nonce = randomUUID().replaceAll("-", "")
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size)/1.5 var(--vscode-font-family); }
    header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    .title { min-width: 0; flex: 1; }
    h1 { margin: 0; font-size: 14px; font-weight: 600; }
    #status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .actions { display: flex; gap: 8px; }
    button { min-height: 30px; padding: 4px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 5px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    #control { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    main { min-height: calc(100vh - 64px); display: grid; place-items: center; padding: 16px; }
    #empty { max-width: 420px; text-align: center; color: var(--vscode-descriptionForeground); }
    #frame { display: none; max-width: 100%; max-height: calc(100vh - 96px); object-fit: contain; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
    #error { max-width: 520px; color: var(--vscode-errorForeground); }
    @media (max-width: 520px) { header { align-items: stretch; flex-direction: column; } .actions { width: 100%; } button { flex: 1; } }
  </style>
</head>
<body>
  <header>
    <div class="title"><h1>Computer Use</h1><div id="status" role="status" aria-live="polite">Preparing a private preview…</div></div>
    <div class="actions"><button id="refresh" type="button">Refresh preview</button><button id="control" type="button">Pause agent control</button></div>
  </header>
  <main>
    <p id="empty">Raya captures the foreground window only when you open or refresh this preview. Desktop actions stay unavailable to agents until the connected tool and safety flow are ready.</p>
    <p id="error" role="alert" hidden></p>
    <img id="frame" alt="Latest foreground window observation">
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const status = document.getElementById("status");
    const frame = document.getElementById("frame");
    const empty = document.getElementById("empty");
    const error = document.getElementById("error");
    const control = document.getElementById("control");
    let manual = false;
    const send = (type) => vscode.postMessage({ type });
    document.getElementById("refresh").addEventListener("click", () => send("refresh"));
    control.addEventListener("click", () => send(manual ? "resume" : "takeover"));
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "loading") { status.textContent = "Capturing foreground window…"; error.hidden = true; }
      if (message.type === "frame") {
        frame.src = message.src; frame.style.display = "block"; empty.hidden = true; error.hidden = true;
        status.textContent = "Observed " + message.width + "×" + message.height + " at " + new Date(message.observedAt).toLocaleTimeString();
      }
      if (message.type === "error") { error.textContent = message.message; error.hidden = false; status.textContent = "Preview unavailable"; }
      if (message.type === "state") {
        manual = message.control === "manual";
        control.textContent = manual ? "Resume agent control" : "Pause agent control";
        if (message.reason) status.textContent = message.reason;
      }
    });
    send("ready");
  </script>
</body>
</html>`
  }
}
