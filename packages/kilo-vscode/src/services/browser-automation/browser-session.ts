// raya_change - Milestone F shared persistent Playwright browser session
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { chromium } from "playwright-core"
import { BrowserSmoke } from "./browser-smoke"
import type { SmokeConsole, SmokeCookie, SmokeInput, SmokeOrigin, SmokeResponse, SmokeResult } from "./browser-smoke"

export type BrowserAction =
  | { operation: "navigate"; url: string }
  | { operation: "snapshot" }
  | { operation: "click"; selector: string }
  | { operation: "type"; selector: string; text: string; submit: boolean }
  | { operation: "select"; selector: string; values: string[] }
  | { operation: "scroll"; deltaX: number; deltaY: number; selector?: string }
  | { operation: "screenshot"; fullPage: boolean }
  | { operation: "evaluate"; expression: string }
  | { operation: "auth_capture"; name: string }
  | ({ operation: "smoke" } & SmokeInput)
type BrowserNativeAction = Exclude<BrowserAction, { operation: "auth_capture" | "smoke" }>

export type BrowserResult =
  | {
      operation: Exclude<BrowserAction["operation"], "auth_capture" | "smoke">
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
      path: string
      cookies: number
      origins: number
    }
  | SmokeResult

export type BrowserFrame = {
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

export interface BrowserPage {
  url(): string
  title(): Promise<string>
  goto(
    url: string,
    options?: { timeout?: number; waitUntil?: "load" },
  ): Promise<{ status(): number } | null | undefined>
  waitForTimeout(timeout: number): Promise<void>
  addInitScript<A>(script: (arg: A) => void, arg: A): Promise<void>
  goBack(): Promise<unknown>
  goForward(): Promise<unknown>
  reload(): Promise<unknown>
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
  screenshot(options: { type: "png"; fullPage: boolean; path?: string }): Promise<Buffer>
  evaluate<R>(fn: (source: string) => R, source: string): Promise<R>
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
  pages(): BrowserPage[]
  newPage(): Promise<BrowserPage>
  newCDPSession(page: BrowserPage): Promise<BrowserCDP>
  storageState(options: { path: string; indexedDB?: boolean }): Promise<{
    cookies: SmokeCookie[]
    origins: SmokeOrigin[]
  }>
  addCookies(cookies: SmokeCookie[]): Promise<void>
  close(): Promise<void>
}

export type BrowserLaunch = (profile: string) => Promise<BrowserContextLike>

// raya_change start - accept model-authored JavaScript expressions without object-literal parse failures
export function evaluate(source: string): unknown {
  const invoke = (value: unknown) => (typeof value === "function" ? value() : value)
  try {
    return invoke(globalThis.eval(`(${source})`) as unknown)
  } catch (wrapped) {
    try {
      return invoke(globalThis.eval(source) as unknown)
    } catch {
      throw wrapped
    }
  }
}
// raya_change end

const launch: BrowserLaunch = async (profile) =>
  (await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: ["--remote-debugging-port=0"],
  })) as unknown as BrowserContextLike

export class BrowserSession {
  private context: BrowserContextLike | undefined
  private page: BrowserPage | undefined
  private cdp: BrowserCDP | undefined
  private start: Promise<void> | undefined
  private frame: BrowserFrame | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private capturing = false
  private queue: Promise<void> = Promise.resolve()
  private last = 0
  private revision = 0
  private running = 0
  private scale = 2 // raya_change - HiDPI capture factor; refined to the webview's devicePixelRatio on resize
  private state: BrowserState = { control: "agent", busy: false }
  private readonly listeners = new Set<(frame: BrowserFrame) => void>()
  private readonly states = new Set<(state: BrowserState) => void>()

  constructor(
    readonly profile: string,
    private readonly launcher: BrowserLaunch = launch,
    private readonly artifacts = join(profile, "raya-smoke"),
  ) {}

  async ready(): Promise<void> {
    if (this.context && this.page && this.cdp) return
    if (this.start) return this.start
    this.start = this.open()
    await this.start.catch(async (error: unknown) => {
      await this.dispose()
      throw error
    })
  }

  private async open(): Promise<void> {
    await mkdir(this.profile, { recursive: true })
    const context = await this.launcher(this.profile)
    const page = context.pages()[0] ?? (await context.newPage())
    this.context = context
    this.page = page
    const cdp = await context.newCDPSession(page)
    this.cdp = cdp
    await cdp.send("Page.enable")
    cdp.on("Page.screencastFrame", (event) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined)
      this.publish({
        data: event.data,
        width: event.metadata.deviceWidth,
        height: event.metadata.deviceHeight,
        url: page.url(),
      })
    })
    // raya_change - render the page at a HiDPI device-scale so the JPEG carries ~scale× the pixels
    // of the 1280×720 layout viewport. The webview then downscales a dense frame instead of
    // upscaling a sparse one, which is what made the view blurry/soft once the panel shrank.
    // The layout viewport stays 1280×720 so pointer/scroll normalization is unchanged.
    await this.metrics()
    await this.screencast()
    // CDP screencast events can pause when headless Chromium considers the surface hidden.
    // Keep the in-editor view live with CDP surface captures while retaining startScreencast as the primary stream.
    this.timer = setInterval(() => void this.capture(), 250)
    await this.capture()
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
    if (this.state.control === "manual" && this.state.busy) return
    this.revision += 1
    this.update({ control: "agent", busy: false })
  }

  takeControl(reason = "You took manual control of the browser."): void {
    this.handover(reason, undefined, this.running > 0)
  }

  async execute(action: BrowserAction): Promise<BrowserResult> {
    const result = this.queue.then(() => this.perform(action))
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async perform(action: BrowserAction): Promise<BrowserResult> {
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

  private async attempt(action: BrowserAction, number: number, revision: number): Promise<BrowserResult> {
    if (revision !== this.revision) throw new Error("Browser action cancelled for manual takeover.")
    await this.pace(number)
    try {
      const result =
        action.operation === "auth_capture" || action.operation === "smoke"
          ? await this.smoke(action)
          : await this.once(action)
      if (revision !== this.revision) throw new Error("Browser action cancelled for manual takeover.")
      return result
    } catch (error) {
      if (this.state.control === "manual") throw error
      if (number < 3) {
        await new Promise((resolve) => setTimeout(resolve, number * 500))
        return this.attempt(action, number + 1, revision)
      }
      const detail = error instanceof Error ? error.message : String(error)
      this.handover(`The ${action.operation} action failed three times: ${detail}`, number)
      throw new Error(`Manual browser takeover required after three failed attempts: ${detail}`)
    }
  }

  private async once(action: BrowserNativeAction): Promise<BrowserResult> {
    const page = this.active()
    if (action.operation === "navigate") {
      const response = await page.goto(action.url, { timeout: 15_000 })
      const status = response?.status()
      if (status === 403 || status === 429) throw new Error(`Site returned HTTP ${status}`)
    }
    if (action.operation === "click") await page.locator(action.selector).click({ timeout: 5_000 })
    if (action.operation === "type") {
      const locator = page.locator(action.selector)
      await locator.fill(action.text, { timeout: 5_000 })
      if (action.submit) await locator.press("Enter", { timeout: 5_000 })
    }
    if (action.operation === "select")
      await page.locator(action.selector).selectOption(action.values, { timeout: 5_000 })
    if (action.operation === "scroll" && action.selector) {
      await page
        .locator(action.selector)
        .evaluate((element, delta) => element.scrollBy(delta.x, delta.y), { x: action.deltaX, y: action.deltaY })
    }
    if (action.operation === "scroll" && !action.selector) await page.mouse.wheel(action.deltaX, action.deltaY)
    const snapshot =
      action.operation === "snapshot" ? await page.locator("body").ariaSnapshot({ timeout: 10_000 }) : undefined
    const data =
      action.operation === "screenshot"
        ? (await page.screenshot({ type: "png", fullPage: action.fullPage })).toString("base64")
        : undefined
    const value = action.operation === "evaluate" ? await page.evaluate(evaluate, action.expression) : undefined
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
  private async smoke(action: Extract<BrowserAction, { operation: "auth_capture" | "smoke" }>): Promise<BrowserResult> {
    if (action.operation === "auth_capture")
      return new BrowserSmoke(this.artifacts, this.active(), this.browser()).capture(action.name)
    return new BrowserSmoke(this.artifacts, this.active(), this.browser()).run({
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

  private assertInput(): void {
    if (this.state.control === "agent" && this.state.busy)
      throw new Error("The agent is currently controlling the browser. Wait for the action to finish or take over.")
  }

  async navigate(url: string): Promise<void> {
    await this.ready()
    this.assertInput()
    await this.active().goto(url)
  }

  async back(): Promise<void> {
    await this.ready()
    this.assertInput()
    await this.active().goBack()
  }

  async forward(): Promise<void> {
    await this.ready()
    this.assertInput()
    await this.active().goForward()
  }

  async reload(): Promise<void> {
    await this.ready()
    this.assertInput()
    await this.active().reload()
  }

  async pointer(input: BrowserPointer): Promise<void> {
    await this.ready()
    this.assertInput()
    const size = this.active().viewportSize() ?? { width: 1280, height: 720 }
    await this.channel().send("Input.dispatchMouseEvent", {
      ...input,
      x: Math.max(0, Math.min(1, input.x)) * size.width,
      y: Math.max(0, Math.min(1, input.y)) * size.height,
      button: input.button ?? "none",
      clickCount: input.clickCount ?? 0,
    })
  }

  async key(input: BrowserKey): Promise<void> {
    await this.ready()
    this.assertInput()
    await this.channel().send("Input.dispatchKeyEvent", {
      ...input,
      text: input.type === "keyDown" ? input.text : undefined,
    })
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.ready()
    this.assertInput()
    await this.active().mouse.wheel(deltaX, deltaY)
  }

  // raya_change start - match the capture density to the panel's real pixel ratio so a resized
  // (especially HiDPI) view stays crisp. Only the device-scale changes; the 1280×720 layout
  // viewport is preserved, so input mapping and everything downstream is unaffected.
  async resize(dpr: number): Promise<void> {
    const next = Math.min(3, Math.max(1, Math.round(Number.isFinite(dpr) && dpr > 0 ? dpr : 1)))
    if (next === this.scale) return
    this.scale = next
    if (!this.cdp) return
    await this.metrics()
    await this.channel().send("Page.stopScreencast").catch(() => undefined)
    await this.screencast()
    await this.capture()
  }

  private async metrics(): Promise<void> {
    await this.channel().send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: this.scale,
      mobile: false,
    })
  }

  private async screencast(): Promise<void> {
    await this.channel().send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: 1280 * this.scale,
      maxHeight: 720 * this.scale,
      everyNthFrame: 1,
    })
  }
  // raya_change end

  async dispose(): Promise<void> {
    const context = this.context
    const cdp = this.cdp
    this.context = undefined
    this.page = undefined
    this.cdp = undefined
    this.start = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.listeners.clear()
    this.states.clear()
    if (cdp) await cdp.send("Page.stopScreencast").catch(() => undefined)
    if (cdp) await cdp.detach().catch(() => undefined)
    if (context) await context.close().catch(() => undefined)
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
    this.frame = frame
    for (const listener of this.listeners) listener(frame)
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
    if (!result?.data) return
    const size = page.viewportSize() ?? { width: 1280, height: 720 }
    this.publish({ data: result.data, width: size.width, height: size.height, url: page.url() })
  }
}
