// raya_change - Milestone F in-editor CDP screencast panel
import * as vscode from "vscode"
import type { BrowserFrame, BrowserKey, BrowserPointer, BrowserState } from "./browser-session"
import { BrowserSession } from "./browser-session"

type BrowserPanelMessage =
  | { type: "ready" }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "resume" }
  | { type: "takeover" }
  | { type: "pointer"; input: BrowserPointer }
  | { type: "scroll"; input: { deltaX: number; deltaY: number } }
  | { type: "resize"; dpr: number } // raya_change - keep capture density matched to the panel's pixel ratio
  | { type: "key"; input: BrowserKey }

export class BrowserPanel implements vscode.Disposable {
  static readonly viewType = "raya.BrowserPanel"

  private panel: vscode.WebviewPanel | undefined
  private off: (() => void) | undefined
  private offState: (() => void) | undefined

  constructor(private readonly session: BrowserSession) {}

  async show(preserveFocus = true): Promise<void> {
    await this.session.ready()
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, preserveFocus)
      return
    }
    const panel = vscode.window.createWebviewPanel(
      BrowserPanel.viewType,
      "Raya Browser",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    )
    this.panel = panel
    panel.webview.html = this.html()
    panel.webview.onDidReceiveMessage((message: BrowserPanelMessage) => this.handle(message))
    panel.onDidDispose(() => {
      this.off?.()
      this.offState?.()
      this.off = undefined
      this.offState = undefined
      this.panel = undefined
    })
    this.off = this.session.onFrame((frame) => void this.frame(frame))
    this.offState = this.session.onState((state) => void this.status(state))
  }

  restore(panel: vscode.WebviewPanel): void {
    this.panel?.dispose()
    this.panel = panel
    panel.webview.options = { enableScripts: true }
    panel.webview.html = this.html()
    panel.webview.onDidReceiveMessage((message: BrowserPanelMessage) => this.handle(message))
    panel.onDidDispose(() => {
      this.off?.()
      this.offState?.()
      this.off = undefined
      this.offState = undefined
      this.panel = undefined
    })
    this.off = this.session.onFrame((frame) => void this.frame(frame))
    this.offState = this.session.onState((state) => void this.status(state))
    void this.session
      .ready()
      .catch((error: unknown) => console.error("[Kilo New] BrowserPanel: browser restore failed:", error))
  }

  private handle(message: BrowserPanelMessage): void {
    void this.receive(message).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      console.error("[Kilo New] BrowserPanel: input failed:", error)
      void vscode.window.showErrorMessage(`Raya Browser: ${detail}`)
    })
  }

  private async receive(message: BrowserPanelMessage): Promise<void> {
    if (message.type === "ready") {
      const frame = this.session.latest()
      if (frame) await this.frame(frame)
      await this.status(this.session.current())
      return
    }
    if (message.type === "navigate") {
      await this.session.navigate(message.url)
      return
    }
    if (message.type === "back") {
      await this.session.back()
      return
    }
    if (message.type === "forward") {
      await this.session.forward()
      return
    }
    if (message.type === "reload") {
      await this.session.reload()
      return
    }
    if (message.type === "resume") {
      this.session.resume()
      return
    }
    if (message.type === "takeover") {
      this.session.takeControl()
      return
    }
    if (message.type === "pointer") {
      await this.session.pointer(message.input)
      return
    }
    if (message.type === "scroll") {
      await this.session.scroll(message.input.deltaX, message.input.deltaY)
      return
    }
    if (message.type === "resize") {
      await this.session.resize(message.dpr)
      return
    }
    await this.session.key(message.input)
  }

  private async frame(frame: BrowserFrame): Promise<void> {
    await this.panel?.webview.postMessage({
      type: "frame",
      data: frame.data,
      width: frame.width,
      height: frame.height,
      url: frame.url,
    })
  }

  private async status(state: BrowserState): Promise<void> {
    await this.panel?.webview.postMessage({ type: "state", state })
  }

  dispose(): void {
    this.off?.()
    this.offState?.()
    this.off = undefined
    this.offState = undefined
    this.panel?.dispose()
    this.panel = undefined
  }

  private html(): string {
    const nonce = crypto.randomUUID().replaceAll("-", "")
    return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    body { display: grid; grid-template-rows: 42px 32px minmax(0, 1fr); }
    header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    button, input { height: 28px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    button { min-width: 30px; cursor: pointer; }
    button:hover { background: var(--vscode-toolbar-hoverBackground); }
    input { flex: 1; padding: 0 8px; }
    #statusbar { display: flex; align-items: center; gap: 8px; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
    #status { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #resume { width: auto; padding: 0 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    #go, #takeover { width: auto; padding: 0 10px; }
    #takeover { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    main { position: relative; display: grid; place-items: center; min-width: 0; min-height: 0; overflow: hidden; background: #111; }
    img { display: block; max-width: 100%; max-height: 100%; outline: none; user-select: none; -webkit-user-drag: none; image-rendering: -webkit-optimize-contrast; }
    #empty { color: var(--vscode-descriptionForeground); }
    #shield { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; color: white; background: rgb(0 0 0 / 28%); cursor: wait; }
    #shield > div { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 4px; background: rgb(0 0 0 / 72%); }
  </style>
</head>
<body>
  <header>
    <button id="back" title="Back" aria-label="Back">←</button>
    <button id="forward" title="Forward" aria-label="Forward">→</button>
    <button id="reload" title="Reload" aria-label="Reload">↻</button>
    <input id="url" aria-label="URL" placeholder="https://example.com">
    <button id="go">Go</button>
  </header>
  <section id="statusbar" aria-live="polite">
    <span id="status">Agent control ready</span>
    <button id="resume" hidden>Resume agent</button>
  </section>
  <main>
    <span id="empty">Starting the shared browser…</span>
    <img id="screen" tabindex="0" alt="Live browser" hidden>
    <div id="shield" hidden><div><span>Agent is controlling the browser…</span><button id="takeover">Take control</button></div></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const screen = document.getElementById("screen");
    const empty = document.getElementById("empty");
    const url = document.getElementById("url");
    const status = document.getElementById("status");
    const resume = document.getElementById("resume");
    const shield = document.getElementById("shield");
    const go = document.getElementById("go");
    const takeover = document.getElementById("takeover");
    const controls = [...document.querySelectorAll("header button, header input")];
    const send = (type, data = {}) => vscode.postMessage({ type, ...data });
    document.getElementById("back").addEventListener("click", () => send("back"));
    document.getElementById("forward").addEventListener("click", () => send("forward"));
    document.getElementById("reload").addEventListener("click", () => send("reload"));
    resume.addEventListener("click", () => send("resume"));
    takeover.addEventListener("click", () => send("takeover"));
    const visit = () => {
      const value = url.value.trim();
      if (!value) return;
      url.blur();
      send("navigate", { url: /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : "https://" + value });
    };
    go.addEventListener("click", visit);
    url.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      visit();
    });
    const point = (event) => {
      const rect = screen.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
        button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left",
      };
    };
    screen.addEventListener("pointerdown", (event) => {
      screen.focus();
      screen.setPointerCapture(event.pointerId);
      send("pointer", { input: { type: "mousePressed", ...point(event), clickCount: event.detail || 1 } });
      event.preventDefault();
    });
    screen.addEventListener("pointerup", (event) => {
      send("pointer", { input: { type: "mouseReleased", ...point(event), clickCount: event.detail || 1 } });
      event.preventDefault();
    });
    let move;
    let moving = false;
    screen.addEventListener("pointermove", (event) => {
      move = event;
      if (moving) return;
      moving = true;
      requestAnimationFrame(() => {
        send("pointer", { input: { type: "mouseMoved", ...point(move), button: "none" } });
        moving = false;
      });
    });
    const modifiers = (event) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    const key = (type, event) => send("key", {
      input: {
        type,
        key: event.key,
        code: event.code,
        text: type === "keyDown" && event.key.length === 1 ? event.key : undefined,
        modifiers: modifiers(event),
      },
    });
    screen.addEventListener("keydown", (event) => { key("keyDown", event); event.preventDefault(); });
    screen.addEventListener("keyup", (event) => { key("keyUp", event); event.preventDefault(); });
    screen.addEventListener("wheel", (event) => { send("scroll", { input: { deltaX: event.deltaX, deltaY: event.deltaY } }); event.preventDefault(); }, { passive: false });
    window.addEventListener("message", (event) => {
      if (event.data.type === "frame") {
        screen.src = "data:image/jpeg;base64," + event.data.data;
        screen.width = event.data.width;
        screen.height = event.data.height;
        screen.hidden = false;
        empty.hidden = true;
        if (document.activeElement !== url) url.value = event.data.url;
        return;
      }
      if (event.data.type !== "state") return;
      const state = event.data.state;
      const manual = state.control === "manual";
      status.textContent = manual
        ? (state.reason || "Manual browser control is active.") + (state.busy ? " Finishing the interrupted action…" : "")
        : state.busy
          ? "Agent action in progress" + (state.attempts ? " (attempt " + state.attempts + " of 3)" : "")
          : "Agent control ready";
      resume.hidden = !manual;
      resume.disabled = manual && state.busy;
      shield.hidden = manual || !state.busy;
      for (const control of controls) control.disabled = state.busy && !manual;
    });
    // raya_change - report the panel's device pixel ratio so the session captures at a matching
    // density; a shrunk/HiDPI panel then downscales a dense frame instead of blurring a sparse one.
    let dpr = 0;
    let debounce;
    const reportDpr = () => {
      const next = window.devicePixelRatio || 1;
      if (next === dpr) return;
      dpr = next;
      send("resize", { dpr: next });
    };
    window.addEventListener("resize", () => {
      clearTimeout(debounce);
      debounce = setTimeout(reportDpr, 200);
    });
    reportDpr();
    send("ready");
  </script>
</body>
</html>`
  }
}
