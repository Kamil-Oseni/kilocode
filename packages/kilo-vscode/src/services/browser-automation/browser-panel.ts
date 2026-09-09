// raya_change - Milestone F in-editor CDP screencast panel
import * as vscode from "vscode"
import { homedir } from "node:os"
import { join } from "node:path"
import { destination, filename } from "./browser-save"
import type { BrowserFrame, BrowserKey, BrowserPointer, BrowserState } from "./browser-session"
import { BrowserSession } from "./browser-session"

type BrowserPanelMessage = { tabID?: string } & (
  | { type: "profile"; action: "select" | "retry" | "reset"; profileID?: string }
  | { type: "auth"; action: "capture" | "restore" | "delete"; profileID?: string; captureID?: string }
  | { type: "ready" }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "resume" }
  | { type: "takeover" }
  | { type: "pointer"; input: BrowserPointer }
  | { type: "scroll"; input: { deltaX: number; deltaY: number } }
  | { type: "resize"; dpr: number; width: number; height: number } // raya_change - drive layout viewport + capture density to the panel
  | { type: "key"; input: BrowserKey }
  | { type: "dialog"; dialogID: string; action: "accept" | "dismiss"; text?: string }
  | { type: "download"; transferID: string; action: "reveal" | "cancel" | "save" }
  | { type: "downloads"; offset: number }
  | { type: "upload"; uploadID: string; action: "cancel" }
  | { type: "tab"; action: "open" | "select" | "close" }
)

export class BrowserPanel implements vscode.Disposable {
  static readonly viewType = "raya.BrowserPanel"

  private panel: vscode.WebviewPanel | undefined
  private off: (() => void) | undefined
  private offDialogs: (() => void) | undefined
  private offDownloads: (() => void) | undefined
  private offUploads: (() => void) | undefined
  private offTabs: (() => void) | undefined
  private offState: (() => void) | undefined
  private offReset: (() => void) | undefined

  constructor(
    private readonly session: BrowserSession,
    private readonly options?: { select: () => Promise<void>; close: () => void },
  ) {}

  async show(preserveFocus = true): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, preserveFocus)
      return
    }
    const panel = vscode.window.createWebviewPanel(
      BrowserPanel.viewType,
      `Raya Browser — ${this.session.workspace.directory.split(/[\\/]/).at(-1)}`,
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
      this.offReset?.()
      this.offUploads?.()
      this.offDownloads?.()
      this.off?.()
      this.offState?.()
      this.offTabs?.()
      this.offDialogs?.()
      this.off = undefined
      this.offState = undefined
      this.panel = undefined
      this.options?.close()
    })
    this.offDialogs = this.session.onDialogs(
      () => void this.panel?.webview.postMessage({ type: "dialogs", ...this.session.dialogsState() }),
    )
    this.offDownloads = this.session.onDownloads(() => void this.downloads())
    this.offUploads = this.session.onUploads(() => void this.uploads())
    this.offTabs = this.session.onTabs((tabs) => void this.panel?.webview.postMessage({ type: "tabs", tabs }))
    this.off = this.session.onFrame((frame) => void this.frame(frame))
    this.offState = this.session.onState((state) => void this.status(state))
    this.offReset = this.session.onReset(() => this.reconnect())
    try {
      await this.session.ready()
    } finally {
      await this.identity()
    }
  }

  restore(panel: vscode.WebviewPanel): void {
    this.panel?.dispose()
    this.panel = panel
    panel.webview.options = { enableScripts: true }
    panel.webview.html = this.html()
    panel.webview.onDidReceiveMessage((message: BrowserPanelMessage) => this.handle(message))
    panel.onDidDispose(() => {
      this.offReset?.()
      this.offUploads?.()
      this.offDownloads?.()
      this.off?.()
      this.offState?.()
      this.offTabs?.()
      this.offDialogs?.()
      this.off = undefined
      this.offState = undefined
      this.panel = undefined
      this.options?.close()
    })
    this.offDialogs = this.session.onDialogs(
      () => void this.panel?.webview.postMessage({ type: "dialogs", ...this.session.dialogsState() }),
    )
    this.offDownloads = this.session.onDownloads(() => void this.downloads())
    this.offUploads = this.session.onUploads(() => void this.uploads())
    this.offTabs = this.session.onTabs((tabs) => void this.panel?.webview.postMessage({ type: "tabs", tabs }))
    this.off = this.session.onFrame((frame) => void this.frame(frame))
    this.offState = this.session.onState((state) => void this.status(state))
    this.offReset = this.session.onReset(() => this.reconnect())
    void this.session.ready().catch(() => this.identity())
  }

  private reconnect() {
    this.offDownloads?.()
    this.offUploads?.()
    this.offDialogs?.()
    this.offDownloads = this.session.onDownloads(() => void this.downloads())
    this.offUploads = this.session.onUploads(() => void this.uploads())
    this.offDialogs = this.session.onDialogs(
      () => void this.panel?.webview.postMessage({ type: "dialogs", ...this.session.dialogsState() }),
    )
    void this.identity().catch(() => console.error("[Raya] Browser identity metadata could not be refreshed."))
  }

  private async identity() {
    const result = await this.session.execute({ operation: "auth", action: "list" })
    if (result.operation !== "auth") return
    await this.panel?.webview.postMessage({ type: "profile", profile: result.profile, captures: result.captures })
  }

  private async lifecycle(message: Extract<BrowserPanelMessage, { type: "profile" | "auth" }>) {
    if (message.type === "profile" && message.action === "select") return this.options?.select()
    if (message.type === "profile" && message.action === "retry") {
      try {
        await this.session.execute({ operation: "profile", action: "retry" })
      } finally {
        await this.identity()
      }
      return
    }
    if (message.profileID !== this.session.workspace.profileID) throw new Error("Observed workspace profile changed")
    if (message.type === "profile") {
      const answer = await vscode.window.showWarningMessage(
        `Reset the browser for ${this.session.workspace.directory}? This closes tabs, discards browser drafts, signs out and deletes saved authentication captures. Downloaded artifacts are preserved.`,
        { modal: true },
        "Reset workspace browser",
      )
      if (answer !== "Reset workspace browser") return
      await this.session.execute({ operation: "profile", action: "reset", profileID: message.profileID })
    }
    if (message.type === "auth" && message.action === "capture") {
      if (!message.tabID) throw new Error("Observe a browser tab before saving authentication")
      const name = await vscode.window.showInputBox({
        title: "Save workspace authentication",
        prompt:
          "Capture all origins in this workspace profile for seven days. A capture does not verify the signed-in account.",
        validateInput: (value) =>
          value.trim() && value.length <= 200 ? undefined : "Enter a label of 1–200 characters",
      })
      if (!name) return
      await this.session.execute({ operation: "auth_capture", tabID: message.tabID, name })
    }
    if (message.type === "auth" && message.action !== "capture") {
      if (!message.captureID) throw new Error("Observe an authentication capture before changing it")
      {
        const answer = await vscode.window.showWarningMessage(
          message.action === "restore"
            ? "This replaces the workspace browser session and closes its tabs. Inspect the intended account again afterward."
            : "Delete this local authentication capture? If it is active or an unfinished restoration used it, this also signs out the workspace browser and closes its tabs. It does not revoke the website session on other devices.",
          { modal: true },
          message.action === "restore" ? "Restore capture" : "Delete capture",
        )
        if (!answer) return
      }
      await this.session.execute({
        operation: "auth",
        action: message.action,
        profileID: message.profileID,
        captureID: message.captureID,
      })
    }
    await this.identity()
  }

  private handle(message: BrowserPanelMessage): void {
    void this.receive(message).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      console.error("[Kilo New] BrowserPanel: input failed:", error)
      void vscode.window.showErrorMessage(`Raya Browser: ${detail}`)
    })
  }

  private async respond(message: Extract<BrowserPanelMessage, { type: "dialog" }>): Promise<void> {
    if (!message.tabID) throw new Error("Observed dialog tab identity is required")
    await this.session.respond(message.tabID, message.dialogID, message.action, message.text)
  }

  private async downloads(offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid download page")
    await this.panel?.webview.postMessage({ type: "downloads", offset, ...(await this.session.downloads(offset)) })
  }

  private async uploads() {
    await this.panel?.webview.postMessage({ type: "uploads", uploads: await this.session.uploadState() })
  }
  private async cancelUpload(id: string) {
    await this.session.cancelUpload(id)
    await this.uploads()
  }

  private async transfer(message: Extract<BrowserPanelMessage, { type: "download" }>) {
    if (message.action === "save") return this.save(message.transferID)
    if (message.action === "cancel") await this.session.cancelDownload(message.transferID)
    if (message.action === "reveal")
      await vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(await this.session.downloadArtifact(message.transferID)),
      )
    await this.downloads()
  }

  private async save(id: string) {
    const info = await this.session.downloadInfo(id)
    if (info.status !== "completed") throw new Error("Download is not complete")
    const target = await vscode.window.showSaveDialog({
      title: "Save a copy of the download",
      saveLabel: "Save copy",
      defaultUri: vscode.Uri.file(join(homedir(), "Downloads", filename(info.filename))),
    })
    if (!target) return
    if (target.scheme !== "file") throw new Error("Choose a local file destination")
    const existing = await destination(target.fsPath)
    if (
      existing &&
      (await vscode.window.showWarningMessage(
        "Replace the existing destination file with this download?",
        { modal: true },
        "Replace",
      )) !== "Replace"
    )
      return
    await this.session.saveDownload(id, target.fsPath, Boolean(existing))
    await vscode.window.showInformationMessage(`Saved ${target.fsPath}`)
  }

  private async initialize() {
    await this.identity()
    await this.uploads()
    await this.downloads()
    const frame = this.session.latest()
    if (frame) await this.frame(frame)
    await this.panel?.webview.postMessage({ type: "dialogs", ...this.session.dialogsState() })
    await this.status(this.session.current())
    if (this.session.profileState().status === "ready")
      await this.panel?.webview.postMessage({ type: "tabs", tabs: await this.session.inventory() })
  }

  private async receive(message: BrowserPanelMessage): Promise<void> {
    if (message.type === "profile" || message.type === "auth") return this.lifecycle(message)
    if (message.type === "ready") return this.initialize()
    if (message.type === "dialog") return this.respond(message)
    if (message.type === "download") return this.transfer(message)
    if (message.type === "upload") return this.cancelUpload(message.uploadID)
    if (message.type === "downloads") return this.downloads(message.offset)
    return this.input(message)
  }

  private async input(
    message: Exclude<
      BrowserPanelMessage,
      { type: "profile" | "auth" | "ready" | "dialog" | "download" | "upload" | "downloads" }
    >,
  ): Promise<void> {
    if (message.type === "tab") {
      if (message.action !== "open" && !message.tabID) throw new Error("Observed tab identity is required")
      await this.session.tab(message.action, message.tabID)
      return
    }
    if (["navigate", "back", "forward", "reload", "pointer", "scroll", "key"].includes(message.type) && !message.tabID)
      throw new Error("Wait for an identified browser frame before sending input")
    if (message.type === "navigate") {
      await this.session.navigate(message.url, message.tabID)
      return
    }
    if (message.type === "back") {
      await this.session.back(message.tabID)
      return
    }
    if (message.type === "forward") {
      await this.session.forward(message.tabID)
      return
    }
    if (message.type === "reload") {
      await this.session.reload(message.tabID)
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
      await this.session.pointer(message.input, message.tabID)
      return
    }
    if (message.type === "scroll") {
      await this.session.scroll(message.input.deltaX, message.input.deltaY, message.tabID)
      return
    }
    if (message.type === "resize") {
      await this.session.resize(message.dpr, message.width, message.height)
      return
    }
    await this.session.key(message.input, message.tabID)
  }

  private async frame(frame: BrowserFrame): Promise<void> {
    await this.panel?.webview.postMessage({
      type: "frame",
      tabID: frame.tabID,
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
    this.offReset?.()
    this.offUploads?.()
    this.offDownloads?.()
    this.off?.()
    this.offState?.()
    this.offTabs?.()
    this.offDialogs?.()
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
    body { display: grid; grid-template-rows: 36px 42px 32px minmax(0, 1fr); }
    header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    button, input, select { height: 28px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
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
    #downloads { position: absolute; bottom: 8px; left: 8px; z-index: 4; max-height: 35%; max-width: 90%; overflow: auto; background: var(--vscode-editor-background); padding: 6px; }
    #downloads:empty { display: none; }
    #uploads { position: absolute; top: 8px; right: 8px; z-index: 4; max-height: 35%; max-width: 45%; overflow: auto; overflow-wrap: anywhere; background: var(--vscode-editor-background); padding: 6px; }
    #uploads:empty { display: none; }
    #shield { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; color: white; background: rgb(0 0 0 / 28%); cursor: wait; }
    #dialogs { position: absolute; inset: 12px; z-index: 3; overflow: auto; pointer-events: none; }
    #dialogs > section { pointer-events: auto; margin: 8px auto; max-width: 640px; padding: 16px; border: 1px solid var(--vscode-focusBorder); background: var(--vscode-editor-background); }
    #dialogs p { white-space: pre-wrap; overflow-wrap: anywhere; }
    #dialogs input { width: 100%; margin-bottom: 10px; }
    #identity { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; }
    #identity summary { cursor: pointer; }
    #identity button { margin: 4px 6px 4px 0; }
    #captures { max-height: 180px; overflow: auto; }
    #identity p { margin: 6px 0; }
    #dialogs button { margin-right: 8px; }
    #shield > div { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 4px; background: rgb(0 0 0 / 72%); }
  </style>
</head>
<body>
  <details id="identity"><summary id="profile-label">Workspace browser identity</summary>
    <p id="profile-state" role="status">Reading browser profile…</p>
    <button id="workspace">Choose workspace</button><button id="retry-browser">Retry browser</button><button id="reset-browser">Reset workspace browser</button><button id="capture-auth">Save authentication</button>
    <p>Authentication captures include this workspace profile's origins and expire after seven days. Login is unverified until you inspect the website.</p>
    <div id="captures" aria-label="Saved authentication captures"></div>
  </details>
  <header><select id="tabs" aria-label="Browser tab"></select><button id="newtab" aria-label="New tab">New tab</button><button id="closetab" aria-label="Close selected tab">Close tab</button></header>
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
    <section id="downloads" aria-label="Downloads" aria-live="polite"></section>
    <section id="uploads" aria-label="Uploads" aria-live="polite"></section>
    <div id="dialogs" aria-live="polite"></div>
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
    const tabs = document.getElementById("tabs");
    const dialogs = document.getElementById("dialogs");
    const downloads = document.getElementById("downloads");
    const uploads = document.getElementById("uploads");
    const captures = document.getElementById("captures");
    let profile;
    const cards = new Map();
    let selected;
    let displayed;
    const controls = [...document.querySelectorAll("header button, header input, header select")];
    const send = (type, data = {}) => vscode.postMessage({ type, tabID: displayed, ...data });
    document.getElementById("workspace").addEventListener("click", () => send("profile", { action: "select" }));
    document.getElementById("retry-browser").addEventListener("click", () => send("profile", { action: "retry" }));
    document.getElementById("reset-browser").addEventListener("click", () => send("profile", { action: "reset", profileID: profile?.profileID }));
    document.getElementById("capture-auth").addEventListener("click", () => send("auth", { action: "capture", profileID: profile?.profileID }));
    document.getElementById("newtab").addEventListener("click", () => send("tab", { action: "open" }));
    document.getElementById("closetab").addEventListener("click", () => send("tab", { action: "close", tabID: selected }));
    tabs.addEventListener("change", () => send("tab", { action: "select", tabID: tabs.value }));
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
      move = { event, tabID: displayed };
      if (moving) return;
      moving = true;
      requestAnimationFrame(() => {
        send("pointer", { tabID: move.tabID, input: { type: "mouseMoved", ...point(move.event), button: "none" } });
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
      if (event.data.type === "profile") {
        const previous = profile;
        profile = event.data.profile;
        document.getElementById("profile-label").textContent = "Workspace: " + profile.directory;
        document.getElementById("profile-state").textContent = "Profile " + profile.profileID.slice(0, 12) + " · " + profile.status + ". " + (profile.message || "") + " Authentication: " + (profile.authentication.source === "capture" ? "restored capture " + (profile.authentication.captureName || profile.authentication.captureID) + "; login unverified" : "live workspace state; login unverified");
        document.getElementById("capture-auth").disabled = profile.status !== "ready";
        if (profile.status !== "ready" || previous && previous.authentication.captureID !== profile.authentication.captureID) {
          displayed = undefined;
          screen.hidden = true;
          empty.hidden = false;
          empty.textContent = profile.message || (profile.status === "closed" ? "Browser closed. Retry to open a clean workspace session." : "Waiting for a fresh browser frame…");
        }
        if (profile.status !== "ready") document.getElementById("identity").open = true;
        captures.replaceChildren();
        for (const capture of event.data.captures) {
          const row = document.createElement("div");
          const label = document.createElement("p");
          label.textContent = capture.name + " · " + capture.status + " · expires " + new Date(capture.expiresAt).toISOString() + " · " + capture.origins.join(", ") + " · Cookie domains: " + capture.domains.join(", ");
          row.append(label);
          for (const action of ["restore", "delete"]) {
            const button = document.createElement("button");
            button.textContent = action === "restore" ? "Restore capture" : "Delete capture";
            button.disabled = action === "restore" && capture.status !== "available";
            button.addEventListener("click", () => send("auth", { action, profileID: profile.profileID, captureID: capture.id }));
            row.append(button);
          }
          captures.append(row);
        }
        return;
      }
      if (event.data.type === "uploads") {
        uploads.replaceChildren();
        for (const item of event.data.uploads) {
          const row = document.createElement("div");
          const label = document.createElement("p");
          label.textContent = item.files.map((file) => file.name + (file.selectedName && file.selectedName !== file.name ? " → " + file.selectedName : "") + " (" + file.bytes + " bytes)").join(", ") + " → " + item.destination + ": " + (item.status === "selected" ? "Files selected; verify the upload result on the page" : item.status) + (item.error ? ": " + item.error : "");
          row.append(label);
          if (item.status === "staging") {
            const button = document.createElement("button");
            button.textContent = "Cancel before selection";
            button.addEventListener("click", () => send("upload", { uploadID: item.id, action: "cancel" }));
            row.append(button);
          }
          uploads.append(row);
        }
        return;
      }
      if (event.data.type === "downloads") {
        downloads.replaceChildren();
        for (const item of event.data.transfers) {
          const row = document.createElement("div");
          const label = document.createElement("span");
          label.textContent = item.filename + " — " + item.status + (item.bytes === undefined ? "" : " (" + item.bytes + " bytes)") + (item.error ? ": " + item.error : "");
          row.append(label);
          const action = item.status === "completed" ? "reveal" : ["waiting", "receiving"].includes(item.status) ? "cancel" : undefined;
          if (action) {
            const button = document.createElement("button");
            button.textContent = action === "reveal" ? "Show file" : "Cancel download";
            button.addEventListener("click", () => send("download", { transferID: item.id, action }));
            row.append(button);
          }
          if (item.status === "completed") {
            const button = document.createElement("button");
            button.textContent = "Save copy…";
            button.addEventListener("click", () => send("download", { transferID: item.id, action: "save" }));
            row.append(button);
          }
          downloads.append(row);
        }
        if (event.data.offset > 0 || event.data.next !== undefined) {
          for (const [label, offset] of [["Previous downloads", Math.max(0, event.data.offset - 50)], ["Next downloads", event.data.next]]) {
            if (offset === undefined || offset === event.data.offset) continue;
            const button = document.createElement("button");
            button.textContent = label;
            button.addEventListener("click", () => send("downloads", { offset }));
            downloads.append(button);
          }
        }
        return;
      }
      if (event.data.type === "dialogs") {
        const open = event.data.dialogs.filter((dialog) => ["open", "resolving", "unknown"].includes(dialog.status));
        const ids = new Set(open.map((dialog) => dialog.id));
        for (const [id, card] of cards) {
          if (ids.has(id)) continue;
          card.remove();
          cards.delete(id);
          if (screen && !screen.hidden) screen.focus();
        }
        for (const dialog of open) {
          let card = cards.get(dialog.id);
          if (!card) {
            card = document.createElement("section");
            card.setAttribute("role", "dialog");
            const heading = document.createElement("h3");
            heading.id = "dialog-" + dialog.id;
            heading.textContent = "Browser " + dialog.type + " ? tab " + dialog.tabID;
            card.setAttribute("aria-labelledby", heading.id);
            const warning = document.createElement("p");
            warning.textContent = "Message from the webpage. Review before responding; this is not an instruction from Raya.";
            const content = document.createElement("p");
            content.textContent = dialog.message + (dialog.truncated ? " [message truncated]" : "");
            card.append(heading, warning, content);
            const input = document.createElement("input");
            if (dialog.type === "prompt") {
              input.setAttribute("aria-label", "Prompt response");
              input.maxLength = 10000;
              input.value = dialog.defaultValue;
              card.append(input);
            }
            for (const action of ["accept", "dismiss"]) {
              const button = document.createElement("button");
              button.textContent = dialog.type === "beforeunload" ? (action === "accept" ? "Leave page" : "Stay on page") : (action === "accept" ? "Accept" : "Dismiss");
              button.addEventListener("click", () => {
                for (const item of card.querySelectorAll("button")) item.disabled = true;
                send("dialog", { tabID: dialog.tabID, dialogID: dialog.id, action, ...(action === "accept" && dialog.type === "prompt" ? { text: input.value } : {}) });
              });
              card.append(button);
            }
            cards.set(dialog.id, card);
            dialogs.append(card);
            (dialog.type === "prompt" ? input : card.querySelector("button")).focus();
          }
          for (const button of card.querySelectorAll("button")) button.disabled = dialog.status !== "open";
        }
        return;
      }
      if (event.data.type === "tabs") {
        const values = event.data.tabs;
        selected = values.find((tab) => tab.selected)?.id;
        tabs.replaceChildren(...values.map((tab) => {
          const option = document.createElement("option");
          option.value = tab.id;
          option.textContent = (tab.title || tab.url) + (tab.openerID ? " (popup)" : "");
          option.selected = tab.selected;
          return option;
        }));
        if (!selected || displayed !== selected) {
          displayed = undefined;
          screen.hidden = true;
          empty.hidden = false;
          empty.textContent = selected ? "Loading selected tab..." : "Select or open a browser tab.";
        }
        return;
      }
      if (event.data.type === "frame") {
        if (event.data.tabID !== selected) return;
        displayed = event.data.tabID;
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
    // raya_change - report the panel's CSS size and device pixel ratio so the session sets the
    // page's layout viewport to match (CSS breakpoints then fire like a real browser resize) and
    // captures at a matching density (a shrunk/HiDPI panel downscales a dense frame instead of
    // blurring a sparse one). Observe the live viewport area, not just window resize.
    const main = document.querySelector("main");
    let last = "";
    let debounce;
    const report = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(main.clientWidth);
      const height = Math.round(main.clientHeight);
      if (!width || !height) return;
      const key = dpr + "x" + width + "x" + height;
      if (key === last) return;
      last = key;
      send("resize", { dpr, width, height });
    };
    const schedule = () => { clearTimeout(debounce); debounce = setTimeout(report, 150); };
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(schedule).observe(main);
    window.addEventListener("resize", schedule);
    report();
    send("ready");
  </script>
</body>
</html>`
  }
}
