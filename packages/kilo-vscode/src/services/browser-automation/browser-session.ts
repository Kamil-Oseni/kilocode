// raya_change - Milestone F shared persistent Playwright browser session
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Script } from "node:vm"
import { chromium } from "playwright-core"
import { Flock } from "@opencode-ai/core/util/flock"
import { locate, TargetError, type BrowserTarget, type TargetPage } from "./browser-target"
import { FrameRegistry, type FrameOwner, type FrameInfo, type DocumentFrame } from "./browser-frame"
import { pending, BrowserDialogs, type DialogPage, type DialogInfo, type DialogOperation } from "./browser-dialog"
import { BrowserSmoke } from "./browser-smoke"
import { BrowserAuth, type AuthSource, type BrowserIdentity, type CaptureInfo, type ProfileInfo } from "./browser-auth"
import { BrowserUploads, type UploadFile, type UploadInfo, type UploadTransport } from "./browser-upload"
import { filename, save } from "./browser-save"
import { BrowserTransfers, type TransferInfo, type TransferOrigin, type TransferPage } from "./browser-transfer"
import type { SmokeConsole, SmokeCookie, SmokeInput, SmokeOrigin, SmokeResponse, SmokeResult } from "./browser-smoke"

export type BrowserAction = {
  tabID?: string
  frameID?: string
  origin?: TransferOrigin
  uploader?: UploadTransport
} & (
  | { operation: "profile"; action: "info" | "retry" }
  | { operation: "profile"; action: "reset"; profileID: string }
  | { operation: "auth"; action: "list" }
  | { operation: "auth"; action: "inspect" | "restore" | "delete"; profileID: string; captureID: string }
  | {
      operation: "upload"
      action: "start"
      uploadID: string
      destination: string
      selector: BrowserTarget
      files: readonly UploadFile[]
    }
  | { operation: "upload"; action: "list" }
  | { operation: "upload"; action: "inspect" | "cancel"; uploadID: string }
  | { operation: "download"; action: "start"; selector: BrowserTarget }
  | { operation: "download"; action: "list"; offset?: number }
  | { operation: "download"; action: "inspect" | "cancel"; transferID: string }
  | {
      operation: "dialog"
      action: "list" | "accept" | "dismiss"
      dialogID?: string
      operationID?: string
      text?: string
    }
  | { operation: "navigate"; url: string }
  | { operation: "snapshot" }
  | { operation: "click"; selector: BrowserTarget; capture?: boolean }
  | { operation: "type"; selector: BrowserTarget; text: string; submit: boolean }
  | { operation: "select"; selector: BrowserTarget; values: string[] }
  | { operation: "scroll"; deltaX: number; deltaY: number; selector?: BrowserTarget }
  | { operation: "screenshot"; fullPage: boolean }
  | { operation: "evaluate"; expression: string }
  | { operation: "auth_capture"; name: string }
  | ({ operation: "smoke" } & SmokeInput)
  | { operation: "frames"; action: "list" | "resolve"; parentID?: string; selector?: string }
  | { operation: "tabs"; action: "list" | "open" | "select" | "close"; url?: string }
)
type BrowserNativeAction = Exclude<
  BrowserAction,
  { operation: "profile" | "auth" | "auth_capture" | "smoke" | "tabs" | "frames" | "dialog" | "download" | "upload" }
>
export type BrowserTab = { id: string; url: string; title: string; selected: boolean; openerID?: string }

export type BrowserResult = {
  profile?: ProfileInfo
  tabID?: string
  frameID?: string
  frameURL?: string
  transfers?: TransferInfo[]
  navigation?: "download"
} & (
  | { operation: "profile"; profile: ProfileInfo; url?: string }
  | { operation: "auth"; captures: CaptureInfo[]; profile: ProfileInfo; url?: string }
  | { operation: "upload"; uploads: UploadInfo[]; url?: string }
  | { operation: "download"; transfers: TransferInfo[]; next?: number; artifact?: string; error?: string; url?: string }
  | { operation: "dialog"; dialogs: DialogInfo[]; operations: DialogOperation[]; url?: string; title?: string }
  | { operation: "frames"; frames: FrameInfo[]; url?: string; title?: string }
  | { operation: "tabs"; tabs: BrowserTab[]; url?: string; title?: string }
  | {
      operation: Exclude<
        BrowserAction["operation"],
        "profile" | "auth" | "auth_capture" | "smoke" | "tabs" | "frames" | "dialog" | "download" | "upload"
      >
      url: string
      title: string
      snapshot?: string
      mime?: "image/png" | "image/jpeg"
      data?: string
      output?: string
    }
  | {
      operation: "auth_capture"
      name: string
      capture: CaptureInfo
      cookies: number
      origins: number
    }
  | SmokeResult
)

export type BrowserFrame = {
  tabID: string
  data: string
  width: number
  height: number
  url: string
}

// raya_change start - rate-limited agent control with explicit manual takeover
export type BrowserState = {
  control: "agent" | "manual"
  busy: boolean
  reason?: string
  attempts?: number
}
// raya_change end

export type BrowserPointer = {
  type: "mouseMoved" | "mousePressed" | "mouseReleased"
  x: number
  y: number
  button?: "left" | "middle" | "right"
  clickCount?: number
}

export type BrowserKey = {
  type: "keyDown" | "keyUp"
  key: string
  code: string
  text?: string
  modifiers?: number
}

type FrameEvent = {
  data: string
  sessionId: number
  metadata: {
    deviceWidth: number
    deviceHeight: number
  }
}

export interface BrowserPage extends TargetPage {
  frames?(): DocumentFrame[]
  mainFrame?(): DocumentFrame
  isClosed?(): boolean
  close?(options?: { runBeforeUnload?: boolean }): Promise<void>
  opener?(): Promise<BrowserPage | null>
  url(): string
  title(): Promise<string>
  goto(
    url: string,
    options?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" | "commit" },
  ): Promise<{ status(): number } | null | undefined>
  waitForTimeout(timeout: number): Promise<void>
  addInitScript<A>(script: (arg: A) => void, arg: A): Promise<void>
  goBack(options?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" | "commit" }): Promise<unknown>
  goForward(options?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" | "commit" }): Promise<unknown>
  reload(options?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" | "commit" }): Promise<unknown>
  locator(selector: string): {
    click(options?: { timeout?: number }): Promise<void>
    fill(text: string, options?: { timeout?: number }): Promise<void>
    press(key: string, options?: { timeout?: number }): Promise<void>
    selectOption(values: string[], options?: { timeout?: number }): Promise<unknown>
    ariaSnapshot(options?: { timeout?: number }): Promise<string>
    evaluate<R, A>(fn: (element: HTMLElement, arg: A) => R, arg: A): Promise<R>
    isVisible(options?: { timeout?: number }): Promise<boolean>
    textContent(options?: { timeout?: number }): Promise<string | null>
  }
  getByRole(role: string, options?: { name?: string | RegExp }): ReturnType<BrowserPage["locator"]>
  screenshot(options: { type: "png"; fullPage: boolean; path?: string }): Promise<Buffer>
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>
  on(event: "response", listener: (response: SmokeResponse) => void): void
  on(event: "console", listener: (message: SmokeConsole) => void): void
  off(event: "response", listener: (response: SmokeResponse) => void): void
  off(event: "console", listener: (message: SmokeConsole) => void): void
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> }
  viewportSize(): { width: number; height: number } | null
}

export interface BrowserCDP {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: "Page.screencastFrame", listener: (event: FrameEvent) => void): void
  detach(): Promise<void>
}

export interface BrowserContextLike {
  browser?(): { isConnected(): boolean } | null
  on?(event: "page", listener: (page: BrowserPage) => void): void
  pages(): BrowserPage[]
  newPage(): Promise<BrowserPage>
  newCDPSession(page: BrowserPage): Promise<BrowserCDP>
  storageState(options: { path?: string; indexedDB?: boolean }): Promise<{
    cookies: SmokeCookie[]
    origins: SmokeOrigin[]
  }>
  addCookies(cookies: SmokeCookie[]): Promise<void>
  setStorageState?(state: { cookies: SmokeCookie[]; origins: SmokeOrigin[] }): Promise<void>
  close(): Promise<void>
}

export type BrowserLaunch = (profile: string) => Promise<BrowserContextLike>

// raya_change start - accept model-authored JS: expressions, statement sequences, and top-level await.
// Parse each candidate without running it. A runtime exception must never select another wrapper.
function prepare(source: string): string {
  const forms = [`(${source})`, source, `(async () => { ${source}\n })()`]
  let last: unknown
  for (const form of forms) {
    try {
      // Bun defers Script parsing until cached data is requested; neither call executes user code.
      new Script(form).createCachedData()
      return form
    } catch (err) {
      last = err instanceof SyntaxError ? err : new SyntaxError(err instanceof Error ? err.message : String(err))
    }
  }
  throw last
}

function execute(source: string | HTMLElement, expression?: string): unknown {
  const value: unknown = globalThis.eval(typeof source === "string" ? source : expression!)
  return typeof value === "function" ? value() : value
}

export function evaluate(source: string): unknown {
  return execute(prepare(source))
}

class OutcomeError extends Error {
  readonly name = "BrowserOutcomeError"

  constructor(operation: string, detail: string) {
    super(
      `The ${operation} action may have taken effect. It was not retried and the current page was preserved. Inspect the destination before repeating it. ${detail}`,
    )
  }
}
// raya_change end

const launch: BrowserLaunch = async (profile) =>
  (await chromium.launchPersistentContext(join(profile, "chromium"), {
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    // raya_change - strip the obvious automated-Chrome tells that make sites (Cloudflare, x.ai)
    // serve a bot wall: drop the "--enable-automation" switch (which sets navigator.webdriver and
    // the "controlled by automated software" surface) and disable the AutomationControlled blink
    // feature. Combined with the real installed Chrome (channel) and a persistent profile, this
    // presents far less like a bot. It does not defeat aggressive challenge pages (Cloudflare Turnstile,
    // x.ai) — no CDP-driven browser fully does — but removes the trivially-detected signals.
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--remote-debugging-port=0", "--disable-blink-features=AutomationControlled"],
  })) as unknown as BrowserContextLike

export class BrowserSession {
  private context: BrowserContextLike | undefined
  private dialogs = new BrowserDialogs()
  private transfers: BrowserTransfers
  private uploads: BrowserUploads
  private readonly auth: BrowserAuth
  private stopAuth?: () => void
  private authentication: AuthSource
  private failure?: { status: "unavailable" | "locked" | "error" | "auth_expired"; message: string }
  private uncertain = false
  private lease?: Flock.Lease
  private changing?: Promise<void>
  private readonly resets = new Set<() => void>()
  private readonly documents = new Map<BrowserPage, FrameRegistry>()
  private readonly tabs = new Map<string, BrowserPage>()
  private readonly identities = new Map<BrowserPage, string>()
  private readonly openers = new Map<BrowserPage, Promise<string | undefined>>()
  private readonly inventories = new Set<(tabs: BrowserTab[]) => void>()
  private page: BrowserPage | undefined
  private cdp: BrowserCDP | undefined
  private start: Promise<void> | undefined
  private frame: BrowserFrame | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private hold: ReturnType<typeof setTimeout> | undefined
  private seen = 0
  private capturing = false
  private queue: Promise<void> = Promise.resolve()
  private last = 0
  private revision = 0
  private running = 0
  private scale = 2 // raya_change - HiDPI capture factor; refined to the webview's devicePixelRatio on resize
  private width = 1280 // raya_change - layout viewport width; tracks the panel so CSS breakpoints fire
  private height = 720 // raya_change - layout viewport height; tracks the panel
  private state: BrowserState = { control: "agent", busy: false }
  private readonly listeners = new Set<(frame: BrowserFrame) => void>()
  private readonly states = new Set<(state: BrowserState) => void>()

  constructor(
    readonly profile: string,
    private readonly launcher: BrowserLaunch = launch,
    private readonly artifacts = join(profile, "raya-smoke"),
    readonly workspace: BrowserIdentity = {
      profileID: createHash("sha256").update(profile).digest("hex"),
      directory: profile,
    },
  ) {
    this.transfers = new BrowserTransfers(join(profile, "raya-downloads"), profile)
    this.uploads = new BrowserUploads(join(profile, "raya-uploads"))
    this.auth = new BrowserAuth(join(profile, "auth"), workspace)
    this.stopAuth = this.auth.watch(() => {
      for (const listener of this.resets) listener()
    })
    this.authentication = { source: "live", profileID: workspace.profileID, login: "unverified" }
  }

  async ready(): Promise<void> {
    if (this.context) return
    if (this.start) return this.start
    this.start = this.open()
    await this.start.catch(async (error: unknown) => {
      await this.dispose(true)
      await this.unlock()
      const message = error instanceof Error ? error.message : String(error)
      this.failure = /Authentication capture expired/i.test(message)
        ? {
            status: "auth_expired",
            message: "Saved authentication expired. Reset this workspace browser or restore a fresh capture.",
          }
        : /Singleton|profile.*in use|user data directory.*in use/i.test(message)
          ? {
              status: "locked",
              message:
                "This workspace browser profile is in use. Close its browser in the other Raya window, then retry. Reset will not break another process's lock.",
            }
          : /executable.*exist|chrome.*not found|distribution.*not found/i.test(message)
            ? {
                status: "unavailable",
                message: "Google Chrome is unavailable. Install Chrome for this user, then retry the Raya browser.",
              }
            : {
                status: "error",
                message:
                  "The workspace browser could not start. Retry; if it still fails, close other Raya browser windows before resetting this workspace's browser session.",
              }
      for (const listener of this.resets) listener()
      throw error
    })
  }

  private async open(): Promise<void> {
    this.stopAuth ??= this.auth.watch(() => {
      for (const listener of this.resets) listener()
    })
    this.failure = undefined
    await this.transfers.load()
    await mkdir(this.profile, { recursive: true })
    await this.lock()
    this.authentication = { source: "live", profileID: this.workspace.profileID, login: "unverified" }
    const saved = await this.saved()
    if (saved) {
      if (!saved.captureID || saved.status !== "restored")
        throw new Error("Saved authentication replacement was not confirmed; reset this workspace browser")
      const capture = await this.auth.read(saved.captureID)
      this.authentication = {
        source: "capture",
        profileID: this.workspace.profileID,
        captureID: capture.info.id,
        captureName: capture.info.name,
        capturedAt: capture.info.createdAt,
        expiresAt: capture.info.expiresAt,
        login: "unverified",
      }
    }
    const context = await this.launcher(this.profile)
    const page = context.pages()[0] ?? (await context.newPage())
    this.context = context
    context.on?.("page", (page) => this.register(page))
    this.register()
    await this.bind(page)
    this.timer = setInterval(() => void this.pump(), 250)
  }

  private async saved() {
    const receipt = join(this.profile, "active-auth.json")
    const stat = await lstat(receipt).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1000))
      throw new Error("Saved authentication provenance is invalid; reset this workspace browser")
    const active = stat ? await readFile(receipt, "utf8") : undefined
    if (!active) return
    try {
      return JSON.parse(active) as { captureID?: string; status?: string }
    } catch {
      throw new Error("Saved authentication provenance is invalid; reset this workspace browser")
    }
  }

  private async bind(page: BrowserPage): Promise<void> {
    const previous = this.cdp
    this.page = page
    this.cdp = undefined
    this.frame = undefined
    if (previous) await previous.detach().catch((error: unknown) => console.error("Browser tab detach failed:", error))
    const cdp = await this.browser().newCDPSession(page)
    this.cdp = cdp
    await cdp.send("Page.enable")
    // raya_change - hide the remaining headless/automation fingerprint before any page loads:
    // drop "HeadlessChrome" from the User-Agent and make navigator.webdriver read undefined, so a
    // fresh navigation isn't flagged as a bot on the very first request.
    const version = (await cdp.send("Browser.getVersion").catch(() => undefined)) as { userAgent?: string } | undefined
    const ua = version?.userAgent?.replace(/HeadlessChrome/i, "Chrome")
    if (ua)
      await cdp
        .send("Emulation.setUserAgentOverride", {
          userAgent: ua,
          acceptLanguage: "en-US,en;q=0.9",
          platform:
            process.platform === "win32" ? "Win32" : process.platform === "darwin" ? "MacIntel" : "Linux x86_64",
        })
        .catch(() => undefined)
    await cdp
      .send("Page.addScriptToEvaluateOnNewDocument", {
        source: "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
      })
      .catch(() => undefined)
    cdp.on("Page.screencastFrame", (event) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined)
      // raya_change - publish the layout viewport, not the screencast's physical metadata, so the
      // panel never swaps between two aspect ratios (the source of the agent-control flicker).
      if (this.page !== page || this.cdp !== cdp) return
      this.publish({
        tabID: this.identity(page),
        data: event.data,
        width: this.width,
        height: this.height,
        url: page.url(),
      })
    })
    // raya_change - render the page at the panel's real CSS size and a HiDPI device-scale: the
    // layout viewport width/height drive CSS media queries (so the page reflows across breakpoints
    // like a real browser instead of just stretching a fixed 1280×720 render), while the
    // device-scale keeps the JPEG dense enough to stay crisp when the panel shrinks or the display
    // is HiDPI. Pointer/scroll map against the same layout size so input stays accurate.
    await this.metrics()
    await this.screencast()
    // raya_change - screencast is the only live producer. capture() is a stall fallback: if no
    // screencast frame arrives for ~1s (headless Chromium treating the surface as hidden), take a
    // still. Running both at once published two JPEG streams at different sizes and flickered.
  }

  private register(observed?: BrowserPage): void {
    for (const page of observed ? [observed] : this.browser().pages()) {
      if (this.identities.has(page)) continue
      const id = randomUUID()
      this.identities.set(page, id)
      this.tabs.set(id, page)
      if (page.isClosed) this.dialogs.attach(page as unknown as DialogPage, id)
      if (page.isClosed) this.transfers.attach(page as unknown as TransferPage, id)
      if (page.frames && page.mainFrame) this.documents.set(page, new FrameRegistry(page as unknown as FrameOwner, id))
      const context = this.context
      if (page.opener)
        this.openers.set(
          page,
          page
            .opener()
            .then((opener) => {
              if (!opener || this.context !== context) return undefined
              this.register(opener)
              return this.identities.get(opener)
            })
            .catch((error: unknown) => {
              console.error("Browser popup ownership could not be established:", error)
              return undefined
            }),
        )
    }
  }

  private identity(page: BrowserPage): string {
    const id = this.identities.get(page)
    if (!id) throw new TargetError("Browser tab identity is unknown; list tabs again.")
    return id
  }

  private resolve(id?: string): BrowserPage {
    this.register()
    if (!id && this.identities.size !== 1)
      throw new TargetError("An observed tab ID is required after multiple tabs have existed. List tabs before acting.")
    const page = id ? this.tabs.get(id) : this.page
    if (!page || page.isClosed?.() || !this.browser().pages().includes(page))
      throw new TargetError("Browser tab is closed or unknown. No action was dispatched; list tabs again.")
    return page
  }

  async inventory(): Promise<BrowserTab[]> {
    await this.ready()
    this.register()
    const result: BrowserTab[] = []
    for (const [id, page] of this.tabs) {
      if (page.isClosed?.() || !this.browser().pages().includes(page)) continue
      const openerID = await this.openers.get(page)
      const title = await page.title().catch(() => "")
      if (page.isClosed?.()) continue
      result.push({
        id,
        url: page.url(),
        title,
        selected: this.page === page,
        openerID,
      })
    }
    return result
  }

  onTabs(listener: (tabs: BrowserTab[]) => void): () => void {
    this.inventories.add(listener)
    return () => this.inventories.delete(listener)
  }

  async tab(action: "open" | "select" | "close", id?: string, url = "about:blank"): Promise<void> {
    await this.ready()
    this.assertInput()
    this.release()
    const result = this.queue.then(() => this.manage({ operation: "tabs", action, tabID: id, url }, () => undefined))
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    await result
  }

  private async manage(
    action: Extract<BrowserAction, { operation: "tabs" }>,
    dispatch: () => void,
  ): Promise<BrowserResult> {
    if (action.action === "open") {
      dispatch()
      const page = await this.browser().newPage()
      this.register()
      await this.bind(page)
      const off = this.transfers.own(this.identity(page), action.origin)
      try {
        await page.goto(action.url ?? "about:blank", this.wait())
      } catch (error) {
        if (!action.origin || !/Download is starting/i.test(error instanceof Error ? error.message : String(error)))
          throw error
        if ((await this.transfers.observed(action.origin)).length === 0) throw error
      } finally {
        off()
      }
    }
    if (action.action === "select") {
      if (!action.tabID) throw new TargetError("Observed tab ID is required to select a tab")
      const page = this.resolve(action.tabID)
      dispatch()
      await this.bind(page)
    }
    if (action.action === "close") {
      if (!action.tabID) throw new TargetError("Observed tab ID is required to close a tab")
      const page = this.resolve(action.tabID)
      if (!page.close) throw new TargetError("Browser host cannot close tabs")
      dispatch()
      if (page.isClosed) {
        const signal = pending<void>()
        const native = page as unknown as DialogPage
        const closed = () => signal.resolve()
        native.on("close", closed)
        try {
          await this.dialogs.unload(
            action.tabID,
            () => page.close!({ runBeforeUnload: true }),
            signal.promise,
            () => page.isClosed!(),
          )
        } finally {
          native.off("close", closed)
        }
      } else await page.close()
      if (page === this.page) {
        this.frame = undefined
        this.page = undefined
        const cdp = this.cdp
        this.cdp = undefined
        await cdp?.detach().catch((error: unknown) => console.error("Closed browser tab detach failed:", error))
      }
    }
    const tabs = await this.inventory()
    for (const listener of this.inventories) listener(tabs)
    return { operation: "tabs", tabs, tabID: this.page ? this.identity(this.page) : undefined }
  }

  latest(): BrowserFrame | undefined {
    return this.frame
  }

  onFrame(listener: (frame: BrowserFrame) => void): () => void {
    this.listeners.add(listener)
    if (this.frame) listener(this.frame)
    return () => this.listeners.delete(listener)
  }

  current(): BrowserState {
    return this.state
  }

  onState(listener: (state: BrowserState) => void): () => void {
    this.states.add(listener)
    listener(this.state)
    return () => this.states.delete(listener)
  }

  resume(): void {
    const blocked = this.dialogs.blocked()
    if (blocked) throw blocked
    this.revision += 1
    this.update({ control: "agent", busy: false })
  }

  takeControl(reason = "You took manual control of the browser."): void {
    this.transfers.takeover()
    this.handover(reason, undefined, this.running > 0)
  }

  profileState(): ProfileInfo {
    return {
      ...this.workspace,
      status: this.uncertain
        ? "error"
        : this.authentication.expiresAt !== undefined && this.authentication.expiresAt <= Date.now()
          ? "auth_expired"
          : (this.failure?.status ??
            (this.context && this.context.browser?.()?.isConnected() !== false ? "ready" : "closed")),
      message: this.uncertain
        ? "Authentication replacement was not confirmed. Reset this workspace browser before continuing."
        : this.failure?.message,
      authentication: { ...this.authentication },
    }
  }

  private async lock() {
    if (this.lease) return
    await mkdir(this.profile, { recursive: true, mode: 0o700 })
    if ((await realpath(this.profile)) !== resolve(this.profile))
      throw new Error("Browser profile storage identity changed")
    const dir = join(this.profile, ".locks")
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if ((await realpath(dir)) !== resolve(dir)) throw new Error("Browser profile lock identity changed")
    this.lease = await Flock.acquire("browser-profile", { dir, timeoutMs: 1000 }).catch(() => {
      throw new Error(
        "Browser profile is in use. Close its other Raya browser window, then retry. An abandoned lock recovers after one minute.",
      )
    })
  }

  private async unlock() {
    const lease = this.lease
    this.lease = undefined
    await lease?.release()
  }

  private async provenance(captureID: string, status: "restoring" | "restored") {
    const path = join(this.profile, `${randomUUID()}.auth-tmp`)
    const file = await open(path, "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify({ captureID, status }))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(path, join(this.profile, "active-auth.json"))
  }

  onReset(listener: () => void) {
    this.resets.add(listener)
    return () => this.resets.delete(listener)
  }

  private async eraseProfile() {
    const root = await realpath(this.profile)
    if (root !== resolve(this.profile)) throw new Error("Browser profile storage identity changed; reset refused")
    const path = join(root, "chromium")
    const canonical = await realpath(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (canonical && canonical !== path) throw new Error("Browser profile identity changed; reset refused")
    if (canonical) await rm(path, { recursive: true })
    await unlink(join(root, "active-auth.json")).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return
      throw error
    })
    this.authentication = { source: "live", profileID: this.workspace.profileID, login: "unverified" }
    this.uncertain = false
    this.failure = undefined
  }

  private async retry() {
    if ((this.profileState().status === "closed" || this.failure) && this.context) await this.dispose(true)
    await this.ready()
  }

  private async restore(restored: Awaited<ReturnType<BrowserAuth["read"]>>) {
    await this.ready()
    const context = this.browser()
    if (!context.setStorageState) throw new Error("Browser runtime cannot replace authentication storage")
    this.uncertain = true
    await this.provenance(restored.info.id, "restoring")
    if (restored.info.expiresAt <= Date.now())
      throw new TargetError(
        "Authentication capture expired before restoration could start. Reset or restore a fresh capture; no saved bytes were dispatched.",
      )
    await context.setStorageState(restored.state).catch(() => {
      throw new Error(
        "Authentication replacement was not confirmed. Its secret contents were not disclosed; reset before continuing.",
      )
    })
    this.authentication = {
      source: "capture",
      profileID: this.workspace.profileID,
      captureID: restored.info.id,
      captureName: restored.info.name,
      capturedAt: restored.info.createdAt,
      expiresAt: restored.info.expiresAt,
      login: "unverified",
    }
    await this.provenance(restored.info.id, "restored")
    this.uncertain = false
  }

  private async lifecycle(action: Extract<BrowserAction, { operation: "profile" | "auth" }>): Promise<BrowserResult> {
    if ("profileID" in action && action.profileID !== this.workspace.profileID)
      throw new TargetError("Observed workspace browser profile does not match this request")
    if (action.operation === "profile" && action.action === "info")
      return { operation: "profile", profile: this.profileState() }
    if (action.operation === "auth" && (action.action === "list" || action.action === "inspect")) {
      const captures = await this.auth.list()
      const selected = action.action === "inspect" ? captures.filter((info) => info.id === action.captureID) : captures
      if (action.action === "inspect" && !selected.length)
        throw new TargetError("Capture is unknown in this workspace profile")
      return { operation: "auth", captures: selected, profile: this.profileState() }
    }
    if (this.changing)
      throw new TargetError(
        "A browser profile change is already in progress; inspect its outcome before another change",
      )
    this.changing = (async () => {
      if (action.operation === "profile" && action.action === "retry") {
        await this.retry()
        return
      }
      await this.lock()
      const saved = action.operation === "auth" && action.action === "delete" ? await this.saved() : undefined
      const restored =
        action.operation === "auth" && action.action === "restore" ? await this.auth.read(action.captureID) : undefined
      const closes =
        action.operation === "profile" ||
        action.action === "restore" ||
        action.captureID === this.authentication.captureID ||
        action.captureID === saved?.captureID
      if (closes) {
        // Native Chromium ownership is checked as well: never delete a profile held by an external browser.
        if (!this.context) this.context = await this.launcher(this.profile)
        this.takeControl("The workspace browser session is being replaced. Old tabs and queued actions are invalid.")
        await this.dispose(true)
        await this.eraseProfile()
      }
      if (action.operation === "profile") await this.auth.clear()
      if (action.operation === "auth" && action.action === "delete") await this.auth.delete(action.captureID)
      if (restored) {
        await this.restore(restored)
      }
      if (closes)
        this.takeControl("Browser identity changed. Inspect the profile and sign-in state, then resume agent control.")
    })()
    try {
      await this.changing
    } finally {
      this.changing = undefined
      if (!this.context) await this.unlock()
      for (const listener of this.resets) listener()
    }
    return action.operation === "profile"
      ? { operation: "profile", profile: this.profileState() }
      : { operation: "auth", captures: await this.auth.list(), profile: this.profileState() }
  }

  async execute(action: BrowserAction): Promise<BrowserResult> {
    if (action.operation === "profile" || action.operation === "auth") return this.lifecycle(action)
    if (this.changing) throw new TargetError("Browser profile replacement is in progress; no action was dispatched")
    if (this.uncertain)
      throw new TargetError(
        "Authentication replacement was not confirmed. Reset this workspace browser before continuing.",
      )
    if (this.failure && this.context) throw new TargetError(this.failure.message)
    if (this.profileState().status === "auth_expired")
      throw new TargetError(
        "Saved authentication expired. Reset this workspace browser or explicitly restore a fresh capture before continuing.",
      )
    const result = await this.executeAction(action)
    return { ...result, profile: this.profileState() }
  }

  private async executeAction(
    action: Exclude<BrowserAction, { operation: "profile" | "auth" }>,
  ): Promise<BrowserResult> {
    if (action.operation === "upload") return this.upload(action)
    if (action.operation === "download" && action.action !== "start") return this.download(action)
    await this.ready()
    if (action.operation === "download") return this.download(action)
    if (action.operation === "dialog") return this.dialog(action)
    const blocked = this.dialogs.blocked()
    if (blocked) throw blocked
    if (action.operation !== "tabs") action = { ...action, tabID: this.identity(this.resolve(action.tabID)) }
    if (["snapshot", "click", "type", "select", "scroll", "evaluate"].includes(action.operation)) {
      const registry = this.documents.get(this.resolve(action.tabID))
      if (action.frameID && !registry) throw new TargetError("Browser host does not support frame identity")
      if (registry) action = { ...action, frameID: registry.lease(action.frameID).id }
    } else if (action.frameID)
      throw new TargetError("This operation is tab-scoped and does not accept a frame identity")
    const result = pending<BrowserResult>()
    const revision = this.revision
    const settled = this.queue.then(() => {
      if (this.revision !== revision)
        throw new TargetError("Queued browser action cancelled by manual control; no action dispatched")
      const job = this.dialogs.start(action.operation, action.tabID ?? "", async () => {
        if (action.operation === "click" && action.capture) {
          if (!action.origin || !action.tabID) throw new TargetError("Download capture requires task and tab identity")
          await this.transfers.arm(action.tabID, action.origin)
        }
        const off = this.transfers.own(action.tabID ?? "", action.origin)
        try {
          const result = await this.perform(action).catch(async (error: unknown) => {
            const transfers = action.origin
              ? /Download is starting/i.test(error instanceof Error ? error.message : String(error))
                ? await this.transfers.observed(action.origin)
                : (await this.transfers.list(action.origin, undefined, 0, action.origin.requestID)).transfers
              : []
            if (action.operation !== "navigate" || transfers.length === 0) throw error
            const page = this.resolve(action.tabID)
            return {
              operation: "navigate" as const,
              tabID: action.tabID,
              url: page.url(),
              title: await page.title(),
              navigation: "download" as const,
              transfers,
            }
          })
          const records = action.origin
            ? (await this.transfers.list(action.origin, undefined, 0, action.origin.requestID)).transfers
            : []
          return records.length ? { ...result, transfers: records } : result
        } finally {
          off()
        }
      })
      void job.result.then(result.resolve, result.reject)
      return job.settled
    })
    this.queue = settled.then(
      () => undefined,
      (error: unknown) => {
        result.reject(error)
      },
    )
    return result.promise
  }

  dialogsState() {
    return this.dialogs.list()
  }

  downloads(offset = 0) {
    return this.transfers.list(undefined, undefined, offset)
  }
  onDownloads(listener: () => void) {
    return this.transfers.onChange(listener)
  }
  downloadArtifact(id: string) {
    return this.transfers.artifact(id)
  }
  async downloadInfo(id: string) {
    return (await this.transfers.list(undefined, id)).transfers[0]
  }
  async saveDownload(id: string, destination: string, replace = false) {
    const source = await this.transfers.artifact(id)
    const info = await this.downloadInfo(id)
    if (info.bytes === undefined || !info.sha256) throw new Error("Download has no verified receipt")
    await save(source, destination, { bytes: info.bytes, sha256: info.sha256 }, replace)
  }
  cancelDownload(id: string) {
    return this.transfers.cancel(id)
  }
  uploadState() {
    return this.uploads.list()
  }
  onUploads(listener: () => void) {
    return this.uploads.onChange(listener)
  }
  cancelUpload(id: string) {
    return this.uploads.cancel(id)
  }

  private async upload(action: Extract<BrowserAction, { operation: "upload" }>): Promise<BrowserResult> {
    if (!action.origin) throw new TargetError("Upload operations require task and request identity")
    if (action.action === "list") return { operation: "upload", uploads: await this.uploads.list(action.origin) }
    if (action.action === "inspect")
      return { operation: "upload", uploads: await this.uploads.list(action.origin, action.uploadID) }
    if (action.action === "cancel")
      return { operation: "upload", uploads: await this.uploads.cancel(action.uploadID, action.origin) }
    if (action.action !== "start" || !action.uploader || !action.tabID)
      throw new TargetError("Upload requires a connected authorized file transport and observed tab")
    if (this.state.control === "manual") throw new TargetError("Resume agent browser control before starting an upload")
    await this.ready()
    const blocked = this.dialogs.blocked()
    if (blocked) throw blocked
    const lease = this.document(action.tabID, action.frameID)
    const expected = new URL(action.destination).href
    const revision = this.revision
    const element = await lease.element(action.selector)
    const check = async () => {
      lease.check()
      if (this.revision !== revision || lease.frame.url() !== expected)
        throw new TargetError("Upload destination changed before file selection")
      if (!element.evaluate || !element.setInputFiles)
        throw new TargetError("Browser host cannot select files on this observed input")
      const input = await element.evaluate(
        (node) => ({
          connected: node.isConnected,
          type: node instanceof HTMLInputElement ? node.type : "",
          multiple: node instanceof HTMLInputElement && node.multiple,
          disabled: node instanceof HTMLInputElement && node.disabled,
        }),
        undefined,
      )
      lease.check()
      if (!input.connected || input.type !== "file" || input.disabled || (action.files.length > 1 && !input.multiple))
        throw new TargetError(
          "Observed upload input is disconnected, disabled, not a file input, or does not accept multiple files",
        )
    }
    try {
      await check()
      const uploads = await this.uploads.start(
        {
          id: action.uploadID,
          origin: action.origin,
          tabID: action.tabID,
          frameID: lease.id,
          destination: expected,
          files: action.files,
        },
        action.uploader,
        async (files, signal, dispatch) => {
          const settled = this.queue.then(async () => {
            await check()
            const blocked = this.dialogs.blocked()
            if (blocked) throw blocked
            this.running++
            this.update({ control: "agent", busy: true, attempts: 1 })
            try {
              const job = this.dialogs.start("upload", action.tabID!, async () => {
                signal.throwIfAborted()
                await check()
                await dispatch()
                await check()
                signal.throwIfAborted()
                await element.setInputFiles!(files, { timeout: 30000 })
                lease.check()
                if (lease.frame.url() !== expected)
                  throw new TargetError(
                    "Upload selected files, but the destination navigated before confirmation; inspect its result",
                  )
                const selected = await element.evaluate!(
                  (node) =>
                    node instanceof HTMLInputElement
                      ? [...(node.files ?? [])].map((file) => ({ name: file.name, bytes: file.size }))
                      : [],
                  undefined,
                )
                lease.check()
                if (
                  selected.length !== action.files.length ||
                  selected.some(
                    (file, index) =>
                      file.name !== filename(action.files[index].name) || file.bytes !== action.files[index].bytes,
                  )
                )
                  throw new TargetError(
                    "File input changed after selection; inspect the destination before selecting again",
                  )
              })
              // Dialog inspection owns the early interruption; the queue follows the actual native continuation.
              void job.result.then(
                () => undefined,
                () => undefined,
              )
              await job.settled
            } finally {
              this.running--
              this.update({ ...this.state, busy: false })
            }
          })
          this.queue = settled.then(
            () => undefined,
            () => undefined,
          )
          await settled
        },
        async () => {
          await element.dispose?.()
        },
      )
      return { operation: "upload", uploads }
    } catch (error) {
      await element.dispose?.()
      throw error
    }
  }

  private async download(action: Extract<BrowserAction, { operation: "download" }>): Promise<BrowserResult> {
    if (!action.origin) throw new TargetError("Download operations require an identified task and request")
    if (action.action === "list")
      return { operation: "download", ...(await this.transfers.list(action.origin, undefined, action.offset)) }
    if (action.action === "cancel") {
      await this.transfers.cancel(action.transferID, action.origin)
      return { operation: "download", ...(await this.transfers.list(action.origin, action.transferID)) }
    }
    if (action.action === "inspect") {
      const result = await this.transfers.list(action.origin, action.transferID)
      const artifact =
        result.transfers[0].status === "completed"
          ? await this.transfers.artifact(action.transferID, action.origin)
          : undefined
      return { operation: "download", ...result, artifact }
    }
    if (action.action !== "start") throw new TargetError("Unknown download action")
    if (!action.tabID) throw new TargetError("Observed download tab identity is required")
    this.resolve(action.tabID)
    const error = await this.execute({
      operation: "click",
      capture: true,
      tabID: action.tabID,
      frameID: action.frameID,
      selector: action.selector,
      origin: action.origin,
    }).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    return {
      operation: "download",
      ...(await this.transfers.list(action.origin, undefined, 0, action.origin.requestID)),
      error,
    }
  }
  onDialogs(listener: () => void): () => void {
    return this.dialogs.onChange(listener)
  }

  async respond(tabID: string, dialogID: string, action: "accept" | "dismiss", text?: string): Promise<void> {
    this.takeControl("You are responding to the browser dialog.")
    await this.dialogs.answer(tabID, dialogID, action, text)
  }

  private async dialog(action: Extract<BrowserAction, { operation: "dialog" }>): Promise<BrowserResult> {
    if (!action.tabID) throw new TargetError("Observed tab identity is required for dialogs")
    if (action.action !== "list") {
      if (this.state.control === "manual")
        throw new TargetError("Manual browser control is active; use the visible dialog controls")
      if (!action.dialogID) throw new TargetError("Observed dialog identity is required")
      await this.dialogs.answer(action.tabID, action.dialogID, action.action, action.text)
    }
    return { operation: "dialog", tabID: action.tabID, ...this.dialogs.list(action.tabID, action.operationID) }
  }

  private async perform(
    action: Exclude<BrowserAction, { operation: "profile" | "auth" | "dialog" | "download" | "upload" }>,
  ): Promise<BrowserResult> {
    await this.ready()
    // A new tool call is an explicit instruction to return control to the agent.
    if (this.state.control === "manual") this.resume()
    this.update({ control: "agent", busy: true })
    const revision = this.revision
    this.running += 1
    return this.attempt(action, 1, revision).finally(() => {
      this.running -= 1
      if (this.state.control === "agent") this.update({ control: "agent", busy: false })
      if (this.state.control === "manual" && this.state.busy) this.update({ ...this.state, busy: false })
    })
  }

  private async attempt(
    action: Exclude<BrowserAction, { operation: "profile" | "auth" | "dialog" | "download" | "upload" }>,
    number: number,
    revision: number,
  ): Promise<BrowserResult> {
    if (revision !== this.revision) throw new Error("Browser action cancelled for manual takeover.")
    await this.pace(number)
    const state = { dispatched: false }
    const dispatch = () => {
      if (revision !== this.revision) throw new TargetError("Browser action cancelled before dispatch.")
      if (action.operation !== "tabs") this.resolve(action.tabID)
      if (action.frameID) this.document(action.tabID, action.frameID).check()
      state.dispatched = true
    }
    try {
      const result =
        action.operation === "tabs"
          ? await this.manage(action, dispatch)
          : action.operation === "frames"
            ? await this.frames(action)
            : action.operation === "auth_capture" || action.operation === "smoke"
              ? await this.smoke(action, dispatch)
              : await this.once(action, dispatch)
      if (revision !== this.revision) throw new Error("Browser action cancelled for manual takeover.")
      return {
        ...result,
        ...(action.operation !== "tabs" ? { tabID: action.tabID } : {}),
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (state.dispatched) throw new OutcomeError(action.operation, detail)
      if (error instanceof TargetError) throw error
      if (this.state.control === "manual") throw error
      if (action.operation !== "snapshot" && action.operation !== "screenshot")
        throw new Error(`The ${action.operation} action was not dispatched: ${detail}`)
      if (this.stuck(detail)) throw new TargetError(`Browser tab observation failed; the tab was preserved. ${detail}`)
      if (/TypeError:|SyntaxError:/i.test(detail)) throw new Error(`The ${action.operation} action failed: ${detail}`)
      if (/strict mode violation|resolved to \d+ elements/i.test(detail)) {
        throw new Error(
          `Locator was not unique (${detail}). Use getByRole with a visible name instead of a shared class.`,
        )
      }
      if (number < 3) {
        await new Promise((resolve) => setTimeout(resolve, number * 500))
        return this.attempt(action, number + 1, revision)
      }
      throw new Error(`The ${action.operation} action failed after three attempts: ${detail}`)
    }
  }

  private stuck(detail: string) {
    return /ERR_CONNECTION_REFUSED|not attached|frame was detached|Target closed|net::ERR_(CONNECTION|ABORTED|FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|TIMED_OUT)/i.test(
      detail,
    )
  }

  private wait() {
    return { timeout: 8_000, waitUntil: "commit" as const }
  }

  private reached(page: BrowserPage, url: string) {
    try {
      return new URL(page.url()).origin === new URL(url).origin
    } catch {
      return false
    }
  }

  private async travel(run: (page: BrowserPage) => Promise<unknown>, id?: string): Promise<void> {
    const page = this.resolve(id)
    try {
      await run(page)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new OutcomeError("navigation", detail)
    }
  }

  private async press(page: BrowserPage, selector: BrowserTarget, dispatch: () => void): Promise<void> {
    if (typeof selector !== "string") {
      const locator = await locate(page, selector)
      dispatch()
      await locator.click({ timeout: 5_000 })
      return
    }
    const named = selector.match(/^button(?:\[name=['"](.+)['"]\]|\.(.+))$/)
    if (named?.[1] || named?.[2]) {
      const name = named[1] ?? named[2]!.replace(/-/g, " ")
      const locator = page.getByRole("button", { name: new RegExp(name, "i") })
      dispatch()
      await locator.click({ timeout: 5_000 })
      return
    }
    const locator = page.locator(selector)
    dispatch()
    await locator.click({ timeout: 5_000 })
  }

  private async drive(action: BrowserNativeAction, page: ReturnType<BrowserSession["active"]>, dispatch: () => void) {
    if (action.operation === "navigate") {
      try {
        dispatch()
        const response = await page.goto(action.url, this.wait())
        const status = response?.status()
        if (status === 403 || status === 429) throw new Error(`Site returned HTTP ${status}`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (/ERR_CONNECTION_REFUSED/i.test(detail))
          throw new Error(`Cannot open ${action.url}: connection refused. Start the app or inspect the listening port.`)
        if (!(/Timeout \d+ms exceeded/i.test(detail) && this.reached(page, action.url))) throw error
      }
      return
    }
    if (action.operation === "click") {
      await this.press(page, action.selector, dispatch)
      return
    }
    if (action.operation === "type") {
      const locator = await locate(page, action.selector)
      dispatch()
      await locator.fill(action.text, { timeout: 5_000 })
      if (action.submit) await locator.press("Enter", { timeout: 5_000 })
      return
    }
    if (action.operation === "select") {
      const locator = await locate(page, action.selector)
      dispatch()
      await locator.selectOption(action.values, { timeout: 5_000 })
      return
    }
    if (action.operation !== "scroll") return
    const delta = { x: action.deltaX, y: action.deltaY }
    if (action.selector) {
      const locator = await locate(page, action.selector)
      if (!locator.evaluate) throw new Error("Browser host cannot scroll the selected target")
      dispatch()
      await locator.evaluate((element, next) => element.scrollBy(next.x, next.y), delta)
      return
    }
    dispatch()
    await page.mouse.wheel(action.deltaX, action.deltaY)
  }

  private document(tabID?: string, frameID?: string) {
    const registry = this.documents.get(this.resolve(tabID))
    if (!registry) throw new TargetError("Browser host does not support frame identity")
    return registry.lease(frameID)
  }

  private async frames(action: Extract<BrowserAction, { operation: "frames" }>): Promise<BrowserResult> {
    const registry = this.documents.get(this.resolve(action.tabID))
    if (!registry) throw new TargetError("Browser host does not support frame discovery")
    const frames =
      action.action === "list"
        ? registry.list()
        : [await registry.resolve(action.parentID ?? "", action.selector ?? "")]
    this.resolve(action.tabID)
    for (const frame of frames) registry.lease(frame.id).check()
    return { operation: "frames", frames }
  }

  private async framed(action: BrowserNativeAction, dispatch: () => void): Promise<BrowserResult> {
    const lease = this.document(action.tabID, action.frameID)
    const state: { snapshot?: string; output?: string } = {}
    if (action.operation === "snapshot") {
      const locator = lease.frame.locator("body")
      if (!locator.ariaSnapshot) throw new TargetError("Browser host cannot snapshot this frame")
      state.snapshot = await locator.ariaSnapshot({ timeout: 10_000 })
    } else {
      if (action.operation === "navigate" || action.operation === "screenshot")
        throw new TargetError("This operation is tab-scoped")
      const target = "selector" in action && action.selector ? action.selector : "html"
      const element = await lease.element(target)
      try {
        const source = action.operation === "evaluate" ? prepare(action.expression) : undefined
        dispatch()
        if (action.operation === "click") await element.click({ timeout: 5_000 })
        if (action.operation === "type") {
          await element.fill(action.text, { timeout: 5_000 })
          if (action.submit) {
            dispatch()
            await element.press("Enter", { timeout: 5_000 })
          }
        }
        if (action.operation === "select") await element.selectOption(action.values, { timeout: 5_000 })
        if (action.operation === "scroll") {
          if (!element.evaluate) throw new TargetError("Browser host cannot scroll this frame")
          await element.evaluate(
            (element, delta) => {
              if (delta.container) element.scrollBy(delta.x, delta.y)
              else element.ownerDocument.defaultView?.scrollBy(delta.x, delta.y)
            },
            { x: action.deltaX, y: action.deltaY, container: !!action.selector },
          )
        }
        if (action.operation === "evaluate") {
          if (!element.evaluate) throw new TargetError("Browser host cannot evaluate this frame")
          const value = await element.evaluate(execute, source!)
          state.output = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))
        }
      } finally {
        await element.dispose?.()
      }
    }
    lease.check()
    const page = this.resolve(action.tabID)
    const title = await page.title()
    lease.check()
    return {
      operation: action.operation,
      url: page.url(),
      title,
      frameID: lease.id,
      frameURL: lease.frame.url(),
      ...state,
    }
  }

  private async once(action: BrowserNativeAction, dispatch: () => void): Promise<BrowserResult> {
    const page = this.resolve(action.tabID)
    if (action.frameID) return this.framed(action, dispatch)
    await this.drive(action, page, dispatch)
    const snapshot =
      action.operation === "snapshot" ? await page.locator("body").ariaSnapshot({ timeout: 10_000 }) : undefined
    const data =
      action.operation === "screenshot"
        ? (await page.screenshot({ type: "png", fullPage: action.fullPage })).toString("base64")
        : undefined
    const value =
      action.operation === "evaluate"
        ? await (async () => {
            const source = prepare(action.expression)
            dispatch()
            return page.evaluate(execute, source)
          })()
        : undefined
    return {
      operation: action.operation,
      url: page.url(),
      title: await page.title(),
      snapshot,
      mime: action.operation === "screenshot" ? "image/png" : undefined,
      data,
      output:
        action.operation === "evaluate"
          ? typeof value === "string"
            ? value
            : (JSON.stringify(value) ?? String(value))
          : undefined,
    }
  }

  // raya_change - Milestone G keeps smoke branching outside the generic browser action runner
  private async smoke(
    action: Extract<BrowserAction, { operation: "auth_capture" | "smoke" }>,
    dispatch: () => void,
  ): Promise<BrowserResult> {
    dispatch()
    if (action.operation === "auth_capture") {
      const state = await this.browser().storageState({ indexedDB: true })
      const capture = await this.auth.capture(action.name, state)
      for (const listener of this.resets) listener()
      return {
        operation: "auth_capture",
        name: capture.name,
        capture,
        cookies: capture.cookies,
        origins: capture.origins.length,
      }
    }
    return new BrowserSmoke(
      this.artifacts,
      this.resolve(action.tabID),
      this.browser(),
      (id) => this.document(action.tabID, id),
      action.tabID,
      this.authentication,
    ).run({
      name: action.name,
      mode: action.mode,
      steps: action.steps,
    })
  }

  private async pace(number: number): Promise<void> {
    this.update({ control: "agent", busy: true, attempts: number })
    const delay = Math.max(0, this.last + 350 - Date.now())
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    this.last = Date.now()
  }

  private handover(reason: string, attempts?: number, busy = false): void {
    this.revision += 1
    this.update({ control: "manual", busy, reason, attempts })
  }

  private update(state: BrowserState): void {
    this.state = state
    for (const listener of this.states) listener(state)
  }

  private input(id?: string): void {
    if (this.resolve(id) !== this.page)
      throw new TargetError("The displayed browser tab changed. Refresh the view before sending input.")
  }

  private assertInput(): void {
    if (this.changing || this.uncertain)
      throw new Error("Browser identity replacement is not settled; inspect its status before interacting")
    if (this.profileState().status === "auth_expired")
      throw new Error("Saved authentication expired. Reset or restore a fresh capture before interacting.")
    const blocked = this.dialogs.blocked()
    if (blocked) throw blocked
    if (this.state.control === "agent" && this.state.busy)
      throw new Error("The agent is currently controlling the browser. Wait for the action to finish or take over.")
  }

  private release(): void {
    this.revision += 1
    if (this.state.control === "manual") {
      this.update({ control: "manual", busy: false, reason: this.state.reason })
      return
    }
    this.update({ control: "agent", busy: false })
  }

  async navigate(url: string, id?: string): Promise<void> {
    await this.ready()
    const blocked = this.dialogs.blocked()
    if (blocked) throw blocked
    this.release()
    const tab = this.identity(this.resolve(id))
    this.input(tab)
    await this.travel((page) => page.goto(url, this.wait()), tab)
  }

  async back(id?: string): Promise<void> {
    await this.ready()
    const blocked = this.dialogs.blocked()
    if (blocked) throw blocked
    this.release()
    this.input(id)
    await this.travel((page) => page.goBack(this.wait()), id)
  }

  async forward(id?: string): Promise<void> {
    await this.ready()
    const blocked = this.dialogs.blocked()
    if (blocked) throw blocked
    this.release()
    this.input(id)
    await this.travel((page) => page.goForward(this.wait()), id)
  }

  async reload(id?: string): Promise<void> {
    await this.ready()
    const blocked = this.dialogs.blocked()
    if (blocked) throw blocked
    this.release()
    this.input(id)
    await this.travel((page) => page.reload(this.wait()), id)
  }

  async pointer(input: BrowserPointer, id?: string): Promise<void> {
    await this.ready()
    this.assertInput()
    this.input(id)
    // raya_change - map normalized coords against the live layout viewport (which now tracks the
    // panel), not Playwright's fixed launch viewport, so clicks land correctly after a resize.
    await this.channel().send("Input.dispatchMouseEvent", {
      ...input,
      x: Math.max(0, Math.min(1, input.x)) * this.width,
      y: Math.max(0, Math.min(1, input.y)) * this.height,
      button: input.button ?? "none",
      clickCount: input.clickCount ?? 0,
    })
  }

  async key(input: BrowserKey, id?: string): Promise<void> {
    await this.ready()
    this.assertInput()
    this.input(id)
    await this.channel().send("Input.dispatchKeyEvent", {
      ...input,
      text: input.type === "keyDown" ? input.text : undefined,
    })
  }

  async scroll(deltaX: number, deltaY: number, id?: string): Promise<void> {
    await this.ready()
    this.assertInput()
    this.input(id)
    await this.active().mouse.wheel(deltaX, deltaY)
  }

  // raya_change start - re-negotiate the layout viewport and capture density to the panel. Setting
  // the layout width/height to the panel's CSS size makes the page honor its own responsive
  // breakpoints (a real browser resize, not a stretched fixed render); deviceScaleFactor = dpr
  // keeps it crisp. Width/height default to 1280×720 when the caller omits them (density-only).
  async resize(dpr: number, width?: number, height?: number): Promise<void> {
    const scale = Math.min(3, Math.max(1, Math.round(Number.isFinite(dpr) && dpr > 0 ? dpr : 1)))
    const w = width && Number.isFinite(width) ? Math.min(2560, Math.max(320, Math.round(width))) : this.width
    const h = height && Number.isFinite(height) ? Math.min(1600, Math.max(240, Math.round(height))) : this.height
    if (scale === this.scale && w === this.width && h === this.height) return
    this.scale = scale
    this.width = w
    this.height = h
    if (!this.cdp) return
    // raya_change - first resize applies immediately (pointer mapping + tests); a burst within 120ms
    // coalesces to one stop/start so ResizeObserver chatter does not thrash the screencast.
    if (this.hold) {
      clearTimeout(this.hold)
      this.hold = setTimeout(() => {
        this.hold = undefined
        void this.apply()
      }, 120)
      return
    }
    this.hold = setTimeout(() => {
      this.hold = undefined
    }, 120)
    await this.apply()
  }

  private async apply(): Promise<void> {
    if (!this.cdp) return
    await this.metrics()
    await this.channel()
      .send("Page.stopScreencast")
      .catch(() => undefined)
    await this.screencast()
  }

  private async metrics(): Promise<void> {
    await this.channel().send("Emulation.setDeviceMetricsOverride", {
      width: this.width,
      height: this.height,
      deviceScaleFactor: this.scale,
      mobile: false,
    })
  }

  private async screencast(): Promise<void> {
    await this.channel().send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: this.width * this.scale,
      maxHeight: this.height * this.scale,
      everyNthFrame: 1,
    })
  }
  // raya_change end

  async dispose(preserve = false): Promise<void> {
    if (!preserve) {
      this.stopAuth?.()
      this.stopAuth = undefined
    }
    this.revision += 1
    const context = this.context
    const cdp = this.cdp
    const uploads = this.uploads
    uploads.stop()
    this.context = undefined
    this.page = undefined
    this.cdp = undefined
    this.start = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.hold) clearTimeout(this.hold)
    this.hold = undefined
    if (!preserve) {
      this.listeners.clear()
      this.states.clear()
      this.inventories.clear()
    }
    this.tabs.clear()
    this.identities.clear()
    this.dialogs.dispose()
    this.dialogs = new BrowserDialogs()
    this.transfers.dispose()
    this.transfers = new BrowserTransfers(join(this.profile, "raya-downloads"), this.profile)
    for (const registry of this.documents.values()) registry.dispose()
    this.documents.clear()
    this.openers.clear()
    if (context)
      await context.close().catch(() => {
        this.context = context
        this.failure = {
          status: "error",
          message:
            "Browser closure was not confirmed. Retry or reset this workspace browser; its profile was not deleted.",
        }
        throw new Error(this.failure.message)
      })
    await uploads.close()
    this.uploads = new BrowserUploads(join(this.profile, "raya-uploads"))
    if (cdp) await cdp.detach().catch(() => undefined)
    if (!preserve) await this.unlock()
  }

  private active(): BrowserPage {
    if (!this.page) throw new Error("Browser page is not ready")
    return this.page
  }

  private channel(): BrowserCDP {
    if (!this.cdp) throw new Error("Browser CDP session is not ready")
    return this.cdp
  }

  private browser(): BrowserContextLike {
    if (!this.context) throw new Error("Browser context is not ready")
    return this.context
  }

  private publish(frame: BrowserFrame): void {
    this.seen = Date.now()
    this.frame = frame
    for (const listener of this.listeners) listener(frame)
  }

  private async pump(): Promise<void> {
    if (this.dialogs.blocked()) return
    if (this.inventories.size) {
      const tabs = await this.inventory().catch(() => [])
      for (const listener of this.inventories) listener(tabs)
    }
    if (this.seen && Date.now() - this.seen < 1000) return
    await this.capture()
  }

  private async capture(): Promise<void> {
    const cdp = this.cdp
    const page = this.page
    if (this.capturing || !cdp || !page || this.listeners.size === 0) return
    this.capturing = true
    const result = (await cdp
      .send("Page.captureScreenshot", { format: "jpeg", quality: 80, fromSurface: true })
      .catch(() => undefined)) as { data?: string } | undefined
    this.capturing = false
    if (!result?.data || this.page !== page || this.cdp !== cdp) return
    // raya_change - report the live layout size (not Playwright's fixed launch viewport) so the
    // panel keeps the correct aspect ratio after a responsive resize.
    this.publish({
      tabID: this.identity(page),
      data: result.data,
      width: this.width,
      height: this.height,
      url: page.url(),
    })
  }
}
