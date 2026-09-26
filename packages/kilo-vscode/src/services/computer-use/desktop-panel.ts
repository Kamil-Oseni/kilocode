import * as vscode from "vscode"
import { randomUUID } from "node:crypto"
import { DesktopSession, type DesktopState } from "./desktop-session"
import {
  ComputerUseLeaseStore,
  type Authorization,
  type AuthorizationRequest,
  type ControlLevel,
  type LeaseAction,
  type SensitivePolicy,
} from "./lease-store"

type Message =
  | { type: "ready" | "refresh" | "takeover" | "resume" | "stop" | "decline" | "clearPolicy" }
  | {
      type: "grant"
      level: ControlLevel
      duration: "session" | "hour" | "until_stopped"
      applications: "all" | "current"
      actions: LeaseAction[]
      sensitive: SensitivePolicy
      rememberPolicy: boolean
      cooperativeInput: boolean
    }

type Pending = {
  request: AuthorizationRequest
  resolve: (result: Authorization) => void
  target?: { windowID: string; title: string; identity: string }
}

export class DesktopPanel implements vscode.Disposable {
  static readonly viewType = "raya.DesktopPanel"

  private panel: vscode.WebviewPanel | undefined
  private off: (() => void) | undefined
  private offLease: (() => void) | undefined
  private pending: Pending | undefined

  constructor(
    private readonly session: DesktopSession,
    private readonly lease: ComputerUseLeaseStore,
    private readonly ready: () => Promise<boolean>,
  ) {}

  async authorize(request: AuthorizationRequest): Promise<Authorization> {
    const result = this.lease.review(request)
    if (result.decision !== "ask") return result
    const lease = this.lease.current()
    if (
      request.sensitive &&
      lease?.state === "active" &&
      lease.level !== "observe" &&
      this.lease.authorize({ ...request, sensitive: false }).decision === "allow"
    )
      return result
    if (this.pending)
      return { operation: "authorize", decision: "deny", reason: "Another Computer Use grant review is active" }
    const target =
      request.surface === "desktop" && request.windowID
        ? await this.session.pinCurrent(request.windowID).catch(() => undefined)
        : undefined
    await this.show()
    return await new Promise<Authorization>((resolve) => {
      this.pending = { request, resolve, target }
      void this.sync()
    })
  }

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
    panel.webview.onDidReceiveMessage((message: Message) => {
      void this.receive(message).catch(() => {
        void vscode.window.showErrorMessage(
          message.type === "stop"
            ? "Raya stopped desktop control locally, but could not confirm saved revocation. Check Computer Use before restarting VS Code."
            : "Raya could not complete that Computer Use action. Desktop control may be paused; check its current state.",
        )
      })
    })
    panel.onDidDispose(() => {
      this.off?.()
      this.off = undefined
      this.offLease?.()
      this.offLease = undefined
      this.panel = undefined
      this.decline("Computer Use grant review closed")
      this.session.takeControl("Computer Use preview closed. Agent desktop control is paused.")
    })
    this.off = this.session.onState((state) => void this.state(state))
    this.offLease = this.lease.onChange(() => void this.sync())
  }

  dispose(): void {
    this.off?.()
    this.off = undefined
    this.offLease?.()
    this.offLease = undefined
    this.decline("Computer Use stopped")
    this.panel?.dispose()
    this.panel = undefined
  }

  private async receive(message: Message): Promise<void> {
    if (message.type === "ready") {
      await this.sync()
      return
    }
    if (message.type === "grant") {
      await this.grant(message)
      return
    }
    if (message.type === "decline") {
      this.decline("You declined desktop control")
      return
    }
    if (message.type === "clearPolicy") {
      await this.lease.clearPolicy()
      await this.sync()
      return
    }
    if (message.type === "stop") {
      const stopped = this.lease.stop()
      this.session.takeControl("Desktop control stopped.")
      this.decline("Desktop control stopped")
      await stopped
      return
    }
    if (message.type === "takeover") {
      const paused = this.lease.pause()
      this.session.takeControl()
      await paused
      return
    }
    if (message.type === "resume") {
      await this.lease.resume()
      if (!(await this.ready())) {
        await this.lease.pause()
        throw new Error("The global Pause Raya shortcut is not ready")
      }
      this.session.resume()
    }
    if (!["refresh", "resume"].includes(message.type)) return
    await this.capture()
  }

  private async grant(message: Extract<Message, { type: "grant" }>): Promise<void> {
    const pending = this.pending
    if (!pending) {
      await this.panel?.webview.postMessage({ type: "error", message: "Start a Raya desktop task first." })
      return
    }
    try {
      const target = message.applications === "current" ? pending.target : undefined
      if (message.applications === "current" && !target)
        throw new Error("No exact window was available when this request began. Return to that window and try again.")
      if (message.applications === "current" && message.duration !== "session")
        throw new Error("This exact window can only be authorized for the current task.")
      if (target) await this.session.verify(target.windowID, target.identity)
      await this.lease.grant({
        sessionID: pending.request.sessionID,
        level: message.level,
        duration: message.duration,
        applications: message.applications,
        windowID: target?.windowID,
        identity: target?.identity,
        actions: message.actions,
        sensitive: message.sensitive,
        cooperativeInput: message.cooperativeInput,
      })
      if (!(await this.ready())) {
        await this.lease.pause()
        this.decline("The global Pause Raya shortcut is not ready")
        return
      }
      const result = this.lease.authorize(pending.request)
      this.pending = undefined
      pending.resolve(result)
      if (message.rememberPolicy === true) {
        await this.lease.savePolicy(message.sensitive).catch(async (error) => {
          await this.panel?.webview.postMessage({
            type: "error",
            message: `Desktop control was granted, but the reusable policy could not be saved: ${error instanceof Error ? error.message : String(error)}`,
          })
        })
      }
      await this.sync()
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private decline(reason: string): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    pending.resolve({ operation: "authorize", decision: "deny", reason })
    void this.sync()
  }

  private async sync(): Promise<void> {
    const lease = this.lease.current()
    await this.panel?.webview.postMessage({
      type: "lease",
      savedPolicy: this.lease.savedPolicy(),
      lease: lease
        ? {
            level: lease.level,
            state: lease.state,
            expiry: lease.expiry,
            applications: lease.applications.kind,
            actions: lease.actions,
            sensitive: lease.sensitive,
            cooperativeInput: lease.cooperativeInput,
          }
        : undefined,
      pending: this.pending
        ? {
            action: this.pending.request.action,
            currentApplicationAvailable: !!this.pending.target,
            currentApplicationTitle: this.pending.target?.title,
          }
        : undefined,
    })
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
    header { display: flex; align-items: center; gap: 12px; min-height: 54px; padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    .title { min-width: 0; flex: 1; }
    h1, h2, p { margin: 0; } h1 { font-size: 14px; } h2 { font-size: 18px; }
    .indicator { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .dot.active { background: var(--vscode-testing-iconPassed); } .dot.paused { background: var(--vscode-editorWarning-foreground); }
    .actions, .buttons { display: flex; gap: 8px; align-items: center; }
    button { min-height: 30px; padding: 4px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); } button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); } button.quiet { color: var(--vscode-foreground); background: transparent; }
    main { min-height: calc(100vh - 54px); padding: clamp(16px, 5vw, 48px); } .shell { width: min(620px, 100%); margin: 0 auto; }
    #grant, #active, .intro { display: grid; gap: 20px; } #grant { padding-top: min(7vh, 56px); } .intro { gap: 8px; }
    .muted { color: var(--vscode-descriptionForeground); } fieldset { margin: 0; padding: 0; border: 0; } legend { margin-bottom: 8px; font-weight: 600; }
    .choices { display: grid; gap: 8px; } .choice { display: grid; grid-template-columns: 20px 1fr; gap: 2px 10px; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-editorWidget-background); cursor: pointer; }
    .choice:hover { border-color: var(--vscode-focusBorder); } .choice:has(input:disabled) { opacity: .55; cursor: not-allowed; } .choice input { grid-row: 1 / span 2; margin: 3px 0 0; } .choice span { color: var(--vscode-descriptionForeground); font-size: 12px; }
    details { border-top: 1px solid var(--vscode-panel-border); padding-top: 12px; } summary { cursor: pointer; font-weight: 500; } .options { display: grid; gap: 10px; padding-top: 12px; }
    .checks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; } .check { display: flex; align-items: center; gap: 7px; } .policy { display: grid; gap: 8px; } .policy-row { display: grid; grid-template-columns: 1fr minmax(150px, auto); gap: 12px; align-items: center; } select { min-height: 30px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 2px 6px; }
    .review, .active-card { padding: 14px; border-radius: 8px; background: var(--vscode-textBlockQuote-background); } .active-card { display: grid; gap: 8px; border: 1px solid var(--vscode-panel-border); }
    .policy-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; } .policy-tools .muted { flex-basis: 100%; } #policy-settings { margin-top: 20px; }
    #frame { display: none; width: 100%; max-height: calc(100vh - 250px); object-fit: contain; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
    [role="alert"] { padding: 10px 12px; border-left: 2px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); }
    @media (max-width: 520px) { header { align-items: stretch; flex-direction: column; } .actions { width: 100%; } .actions button { flex: 1; } main { padding: 16px; } #grant { padding-top: 16px; } .checks { grid-template-columns: 1fr; } .buttons { flex-direction: column-reverse; align-items: stretch; } }
  </style>
</head>
<body>
  <header>
    <div class="title"><h1>Desktop control</h1><div class="indicator"><span id="dot" class="dot"></span><span id="status" role="status" aria-live="polite">Off</span></div></div>
    <div class="actions"><button id="refresh" class="quiet" type="button" hidden>Refresh preview</button><button id="control" class="secondary" type="button" hidden>Pause</button><button id="stop" class="secondary" type="button" hidden>Stop</button></div>
  </header>
  <main><div class="shell">
    <section id="grant" hidden>
      <div class="intro"><h2>Let Raya work on your desktop</h2><p class="muted">Choose once for this task. You can pause or stop Raya at any time.</p></div>
      <fieldset><legend>Control level</legend><div class="choices">
        <label class="choice"><input type="radio" name="level" value="observe"><strong>Observe only</strong><span>Inspect the desktop without clicking or typing.</span></label>
        <label class="choice"><input type="radio" name="level" value="assisted" checked><strong>Assisted control</strong><span>Continue ordinary actions. Ask before sensitive actions.</span></label>
        <label class="choice"><input type="radio" name="level" value="autonomous"><strong>Autonomous control</strong><span>Continue across approved apps and actions without repeated prompts.</span></label>
      </div></fieldset>
      <fieldset><legend>Where and for how long</legend><div class="choices">
        <label class="choice"><input type="radio" name="apps" value="all" checked><strong>All visible applications</strong><span>Work across the desktop for the selected duration.</span></label>
        <label id="current-choice" class="choice"><input id="current-app" type="radio" name="apps" value="current"><strong>This exact window</strong><span id="current-target">Available for this task only.</span></label>
        <label class="choice"><input type="radio" name="duration" value="session" checked><strong>This task</strong><span>Ends with this Raya task or when you stop it.</span></label>
        <label class="choice"><input type="radio" name="duration" value="hour"><strong>One hour</strong><span>Expires automatically across Raya sessions. Requires all applications.</span></label>
        <label class="choice"><input type="radio" name="duration" value="until_stopped"><strong>All sessions until I stop</strong><span>Saved locally and remains active across restarts. Requires all applications.</span></label>
      </div></fieldset>
      <details><summary>Choose action categories</summary><div class="options"><div id="checks" class="checks"></div><label class="check"><input id="cooperative" type="checkbox"> Cooperative input</label><p class="muted">When off, your input will pause Raya after takeover detection is enabled.</p></div></details>
      <details><summary>Sensitive-action policy</summary><div class="options"><p class="muted">Each category asks by default. A saved policy only fills these choices when you select Use saved choices; every new grant still needs your approval.</p><div id="saved-policy" class="policy-tools" hidden><button id="use-policy" class="secondary" type="button">Use saved choices</button><button id="clear-policy" class="quiet" type="button">Delete saved choices</button><span class="muted">Saved on this computer. It cannot start desktop control by itself.</span></div><div id="policy" class="policy"></div><label class="check"><input id="remember-policy" type="checkbox"> Save these sensitive choices for future grant reviews</label></div></details>
      <p id="review" class="review"></p><p id="grant-error" role="alert" hidden></p>
      <div class="buttons"><button id="decline" class="secondary" type="button">Not now</button><button id="grant-button" type="button">Allow and continue</button></div>
    </section>
    <section id="active" hidden><div class="active-card"><h2 id="active-title">Raya is ready</h2><p id="active-summary" class="muted"></p></div><p id="empty" class="muted">Preview is private and captured only when you select Refresh preview.</p><p id="active-error" role="alert" hidden></p><img id="frame" alt="Latest foreground window observation"></section>
    <section id="idle"><div class="intro"><h2>Desktop control is off</h2><p class="muted">Ask Raya to do something on your computer. You will review one grant before control begins.</p></div></section>
    <section id="policy-settings" class="active-card" hidden><strong>Saved sensitive choices</strong><p class="muted">These choices can fill a future grant review. They never start control or change an active grant.</p><div><button id="clear-policy-settings" class="secondary" type="button">Delete saved choices</button></div></section>
  </div></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const byId = (id) => document.getElementById(id);
    const status = byId("status"), dot = byId("dot"), frame = byId("frame"), empty = byId("empty");
    const grant = byId("grant"), active = byId("active"), idle = byId("idle"), grantError = byId("grant-error"), activeError = byId("active-error");
    const control = byId("control"), stop = byId("stop"), refresh = byId("refresh"), review = byId("review");
    let manual = false, pending = false, savedPolicy, targetTitle;
    const labels = { observe: "Observe only", assisted: "Assisted control", autonomous: "Autonomous control" };
    const actionLabels = { observe: "Observe", pointer: "Pointer and clicks", keyboard: "Keyboard and text", scroll: "Scroll", window: "Switch windows", launch: "Launch apps", browser: "Browser", files: "File Explorer" };
    const defaults = { observe: ["observe"], assisted: ["observe", "pointer", "keyboard", "scroll", "window"], autonomous: Object.keys(actionLabels) };
    const categoryLabels = { communications: "Send messages, email or posts", financial: "Purchases and payments", credentials: "Passwords and secrets", software: "Install or remove software", system: "Security or system settings", deletion: "Permanent deletion", disclosure: "Upload or disclose private files", legal: "Contracts or legal terms", publishing: "Commit, push, deploy or publish" };
    const ruleLabels = { ask: "Ask before", allow_session: "Allow this session", allow_always: "Allow every time", deny: "Deny" };
    const selected = (name) => document.querySelector('input[name="' + name + '"]:checked')?.value;
    const chosen = () => [...document.querySelectorAll('#checks input:checked')].map((input) => input.value);
    const policy = () => Object.fromEntries([...document.querySelectorAll('#policy select')].map((input) => [input.dataset.category, input.value]));
    const send = (type) => vscode.postMessage({ type });
    const drawActions = () => { const level = selected("level") || "assisted"; byId("checks").innerHTML = Object.entries(actionLabels).map(([value, label]) => '<label class="check"><input type="checkbox" value="' + value + '" ' + (defaults[level].includes(value) ? 'checked' : '') + '>' + label + '</label>').join(''); };
    const drawPolicy = () => { byId("policy").innerHTML = Object.entries(categoryLabels).map(([category, label]) => '<label class="policy-row"><span>' + label + '</span><select data-category="' + category + '">' + Object.entries(ruleLabels).map(([value, name]) => '<option value="' + value + '">' + name + '</option>').join('') + '</select></label>').join(''); };
    const applyPolicy = () => { if (!savedPolicy) return; document.querySelectorAll('#policy select').forEach((input) => { if (Object.hasOwn(savedPolicy, input.dataset.category)) input.value = savedPolicy[input.dataset.category]; }); summarize(); };
    const summarize = () => {
      const level = selected("level") || "assisted";
      const apps = selected("apps") === "current" ? "this exact window" + (targetTitle ? " (" + targetTitle + ")" : "") : "all visible applications";
      const duration = selected("duration") === "session" ? "this task" : selected("duration") === "hour" ? "one hour" : "all sessions until you stop";
      const sensitive = level === "assisted" ? "Sensitive actions always ask first; Deny still applies." : level === "observe" ? "Raya cannot click or type." : "Sensitive actions follow the policy below.";
      review.textContent = labels[level] + " in " + apps + " for " + duration + ". " + sensitive;
    };
    document.querySelectorAll('input[name="level"]').forEach((input) => input.addEventListener("change", () => { drawActions(); summarize(); }));
    const scopeDuration = () => { const exact = selected("apps") === "current"; if (exact) document.querySelector('input[name="duration"][value="session"]').checked = true; document.querySelectorAll('input[name="duration"]').forEach((input) => { if (input.value !== "session") input.disabled = exact; }); summarize(); };
    document.querySelectorAll('input[name="apps"]').forEach((input) => input.addEventListener("change", scopeDuration));
    document.querySelectorAll('input[name="duration"]').forEach((input) => input.addEventListener("change", summarize));
    refresh.addEventListener("click", () => send("refresh")); control.addEventListener("click", () => send(manual ? "resume" : "takeover")); stop.addEventListener("click", () => send("stop")); byId("decline").addEventListener("click", () => send("decline"));
    byId("use-policy").addEventListener("click", applyPolicy); byId("clear-policy").addEventListener("click", () => send("clearPolicy")); byId("clear-policy-settings").addEventListener("click", () => send("clearPolicy"));
    byId("grant-button").addEventListener("click", () => vscode.postMessage({ type: "grant", level: selected("level"), duration: selected("duration"), applications: selected("apps"), actions: chosen(), sensitive: policy(), rememberPolicy: byId("remember-policy").checked, cooperativeInput: byId("cooperative").checked }));
    window.addEventListener("message", (event) => { const message = event.data;
      if (message.type === "loading") { status.textContent = "Capturing foreground window…"; activeError.hidden = true; }
      if (message.type === "frame") { frame.src = message.src; frame.style.display = "block"; empty.hidden = true; activeError.hidden = true; status.textContent = "Observed " + message.width + "×" + message.height + " at " + new Date(message.observedAt).toLocaleTimeString(); }
      if (message.type === "error") { const target = pending ? grantError : activeError; target.textContent = message.message; target.hidden = false; }
      if (message.type === "lease") { const saved = message.lease; savedPolicy = message.savedPolicy; byId("saved-policy").hidden = !savedPolicy; const fresh = !pending && !!message.pending; pending = !!message.pending; targetTitle = message.pending?.currentApplicationAvailable ? message.pending.currentApplicationTitle : undefined; byId("policy-settings").hidden = pending || !savedPolicy; grant.hidden = !pending; active.hidden = pending || !saved; idle.hidden = pending || !saved; refresh.hidden = pending || !saved; control.hidden = pending || !saved; stop.hidden = pending || !saved; byId("current-app").disabled = !message.pending?.currentApplicationAvailable; byId("current-choice").style.opacity = message.pending?.currentApplicationAvailable ? "1" : ".55"; byId("current-target").textContent = message.pending?.currentApplicationAvailable ? message.pending.currentApplicationTitle + " · this task only" : "Bring the window forward, then ask Raya again.";
        if (pending) { if (fresh) { document.querySelector('input[name="level"][value="assisted"]').checked = true; document.querySelector('input[name="apps"][value="all"]').checked = true; document.querySelector('input[name="duration"][value="session"]').checked = true; byId("cooperative").checked = false; drawActions(); drawPolicy(); byId("remember-policy").checked = false; } scopeDuration(); status.textContent = "Your approval is needed"; dot.className = "dot"; }
        if (saved) { manual = saved.state === "paused"; dot.className = "dot " + (manual ? "paused" : "active"); status.textContent = manual ? "Paused" : labels[saved.level] + " active"; control.textContent = manual ? "Resume" : "Pause"; byId("active-title").textContent = manual ? "Raya is paused" : labels[saved.level] + " is active"; const until = saved.expiry.kind === "expires_at" ? " until " + new Date(saved.expiry.expiresAt).toLocaleTimeString() : " until you stop it"; byId("active-summary").textContent = (saved.applications === "all" ? "All visible applications" : "This exact window") + until + "."; }
        if (!saved && !pending) { status.textContent = "Off"; dot.className = "dot"; }
      }
      if (message.type === "state") { manual = message.control === "manual"; control.textContent = manual ? "Resume" : "Pause"; if (message.reason) status.textContent = message.reason; }
    });
    drawActions(); drawPolicy(); summarize(); send("ready");
  </script>
</body>
</html>`
  }
}
