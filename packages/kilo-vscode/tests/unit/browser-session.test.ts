// raya_change - Milestone F drive/watch, input forwarding, and login persistence
import { describe, expect, it } from "bun:test"
import type {
  BrowserCDP,
  BrowserContextLike,
  BrowserLaunch,
  BrowserPage,
} from "../../src/services/browser-automation/browser-session"
import { BrowserSession, evaluate } from "../../src/services/browser-automation/browser-session"

class FakeCDP implements BrowserCDP {
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  private listener: ((event: Parameters<Parameters<BrowserCDP["on"]>[1]>[0]) => void) | undefined

  async send(method: string, params?: Record<string, unknown>): Promise<void> {
    this.commands.push({ method, params })
  }

  on(_event: "Page.screencastFrame", listener: Parameters<BrowserCDP["on"]>[1]): void {
    this.listener = listener
  }

  emit(data: string): void {
    this.listener?.({
      data,
      sessionId: 7,
      metadata: { deviceWidth: 1280, deviceHeight: 720 },
    })
  }

  async detach(): Promise<void> {}
}

class FakePage implements BrowserPage {
  current = "about:blank"
  readonly clicks: string[] = []
  clickAttempts = 0
  failClicks = 0
  gotoAttempts = 0
  failNavigations = 0
  delay = 0
  pause: Promise<void> | undefined
  active = 0
  maxActive = 0
  readonly fills: Array<{ selector: string; text: string }> = []
  readonly selects: Array<{ selector: string; values: string[] }> = []
  readonly scrolls: Array<{ x: number; y: number }> = []

  constructor(private readonly state: { cookie: string }) {}

  url(): string {
    return this.current
  }

  async title(): Promise<string> {
    return "Test page"
  }

  refuse = false
  hang = false

  waitUntil = ""

  async goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<{ status(): number }> {
    this.gotoAttempts += 1
    this.waitUntil = options?.waitUntil ?? "load"
    if (this.refuse) throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${url}`)
    if (this.hang) throw new Error("page.goto: Timeout 30000ms exceeded")
    this.current = url
    return { status: () => (this.gotoAttempts <= this.failNavigations ? 429 : 200) }
  }

  async goBack(options?: { waitUntil?: string }): Promise<void> {
    this.waitUntil = options?.waitUntil ?? "load"
  }
  async goForward(options?: { waitUntil?: string }): Promise<void> {
    this.waitUntil = options?.waitUntil ?? "load"
  }
  async reload(options?: { waitUntil?: string }): Promise<void> {
    this.waitUntil = options?.waitUntil ?? "load"
    if (this.hang) throw new Error("page.reload: Timeout 30000ms exceeded.\nCall log:\n  - waiting for navigation until \"load\"")
    if (this.refuse) throw new Error("page.reload: Protocol error (Page.reload): Not attached to an active page")
  }
  async waitForTimeout(): Promise<void> {}
  async addInitScript(): Promise<void> {}

  locator(selector: string) {
    return {
      click: async () => {
        this.clickAttempts += 1
        this.active += 1
        this.maxActive = Math.max(this.maxActive, this.active)
        if (this.pause) await this.pause
        if (this.delay > 0) await new Promise((resolve) => setTimeout(resolve, this.delay))
        this.active -= 1
        if (this.clickAttempts <= this.failClicks) {
          throw new Error(this.hang ? "locator.click: Timeout 5000ms exceeded" : "element is not ready")
        }
        this.clicks.push(selector)
      },
      fill: async (text: string) => {
        this.fills.push({ selector, text })
      },
      press: async () => undefined,
      selectOption: async (values: string[]) => {
        this.selects.push({ selector, values })
      },
      ariaSnapshot: async () => `- document: ${this.current}`,
      evaluate: async <R>() => undefined as R,
      isVisible: async () => true,
      textContent: async () => "visible",
    }
  }

  getByRole(role: string, options?: { name?: string | RegExp }) {
    const name = options?.name instanceof RegExp ? options.name.source : (options?.name ?? "")
    return this.locator(`${role}:${name}`)
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from("png")
  }

  async evaluate<R>(fn: (source: unknown) => R, source: unknown): Promise<R> {
    const value = typeof source === "string" ? source.match(/^document\.cookie\s*=\s*["'](.+)["']$/)?.[1] : undefined
    if (value) {
      this.state.cookie = value
      return value as R
    }
    if (source === "document.cookie") return this.state.cookie as R
    return fn(source)
  }

  on(): void {}
  off(): void {}

  readonly mouse = {
    wheel: async (x: number, y: number) => {
      this.scrolls.push({ x, y })
    },
  }

  viewportSize() {
    return { width: 1280, height: 720 }
  }
}

function harness() {
  const profiles = new Map<string, { cookie: string }>()
  const cdps: FakeCDP[] = []
  const pages: FakePage[] = []
  const launch: BrowserLaunch = async (profile) => {
    const state = profiles.get(profile) ?? { cookie: "" }
    profiles.set(profile, state)
    const page = new FakePage(state)
    const cdp = new FakeCDP()
    pages.push(page)
    cdps.push(cdp)
    return {
      pages: () => [page],
      newPage: async () => page,
      newCDPSession: async () => cdp,
      storageState: async () => ({ cookies: [], origins: [] }),
      addCookies: async () => undefined,
      close: async () => undefined,
    } satisfies BrowserContextLike
  }
  return { launch, cdps, pages }
}

describe("Raya browser session", () => {
  it("evaluates object literals, functions, and statement sequences", () => {
    expect(evaluate("{ values: Array.from([1, 2]).map((value) => value * 2) }")).toEqual({ values: [2, 4] })
    expect(evaluate("() => ({ ok: true })")).toEqual({ ok: true })
    expect(evaluate("const value = 2; value * 3")).toBe(6)
    expect(evaluate("var n = 1; n + 2")).toBe(3)
    expect(evaluate("1 + 1;")).toBe(2)
  })

  it("evaluates top-level await and surfaces the last failure, not the wrap SyntaxError", async () => {
    const pending = evaluate("const n = await Promise.resolve(4); return n")
    expect(pending).toBeInstanceOf(Promise)
    expect(await pending).toBe(4)
    expect(() => evaluate("???")).toThrow(SyntaxError)
    try {
      evaluate("???")
    } catch (err) {
      expect(String(err)).not.toMatch(/Unexpected token ';'/)
    }
  })

  it("drives a page while forwarding CDP screencast frames to watchers", async () => {
    const fake = harness()
    const session = new BrowserSession("test-profile", fake.launch)
    const frames: string[] = []
    session.onFrame((frame) => frames.push(`${frame.url}:${frame.data}`))

    await session.execute({ operation: "navigate", url: "https://example.test/app" })
    await session.execute({ operation: "click", selector: "#continue" })
    fake.cdps[0]!.emit("frame-1")

    expect(fake.pages[0]!.clicks).toEqual(["#continue"])
    expect(frames).toEqual(["https://example.test/app:frame-1"])
    expect(fake.cdps[0]!.commands.some((item) => item.method === "Page.startScreencast")).toBe(true)
    await session.dispose()
  })

  it("forwards panel pointer and keyboard input through the CDP Input domain", async () => {
    const fake = harness()
    const session = new BrowserSession("test-profile", fake.launch)

    await session.pointer({ type: "mousePressed", x: 0.5, y: 0.25, button: "left", clickCount: 1 })
    await session.key({ type: "keyDown", key: "a", code: "KeyA", text: "a" })

    expect(fake.cdps[0]!.commands).toContainEqual({
      method: "Input.dispatchMouseEvent",
      params: expect.objectContaining({ x: 640, y: 180, button: "left" }),
    })
    expect(fake.cdps[0]!.commands).toContainEqual({
      method: "Input.dispatchKeyEvent",
      params: expect.objectContaining({ key: "a", code: "KeyA", text: "a" }),
    })
    await session.dispose()
  })

  // raya_change - resize keeps capture density matched to the panel so it stays crisp when scaled.
  it("captures at HiDPI and re-negotiates density when the panel pixel ratio changes", async () => {
    const fake = harness()
    const session = new BrowserSession("test-profile", fake.launch)
    await session.ready()
    const cdp = fake.cdps[0]!

    // Opens at a 2× device-scale over a 1280×720 layout viewport.
    expect(cdp.commands).toContainEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: expect.objectContaining({ width: 1280, height: 720, deviceScaleFactor: 2 }),
    })
    expect(cdp.commands.find((item) => item.method === "Page.startScreencast")?.params).toMatchObject({
      maxWidth: 2560,
      maxHeight: 1440,
    })

    cdp.commands.length = 0
    await session.resize(3)
    expect(cdp.commands.find((item) => item.method === "Emulation.setDeviceMetricsOverride")?.params).toMatchObject({
      deviceScaleFactor: 3,
    })
    expect(cdp.commands.filter((item) => item.method === "Page.startScreencast").at(-1)?.params).toMatchObject({
      maxWidth: 3840,
      maxHeight: 2160,
    })

    // A no-op ratio must not thrash the stream.
    cdp.commands.length = 0
    await session.resize(3)
    expect(cdp.commands.some((item) => item.method === "Page.startScreencast")).toBe(false)
    await session.dispose()
  })

  it("keeps screencast as the only live frame source and coalesces a resize burst", async () => {
    const fake = harness()
    const session = new BrowserSession("test-profile", fake.launch)
    const frames: Array<{ data: string; width: number; height: number }> = []
    session.onFrame((frame) => frames.push({ data: frame.data, width: frame.width, height: frame.height }))
    await session.ready()
    const cdp = fake.cdps[0]!

    cdp.emit("live")
    expect(frames.at(-1)).toEqual({ data: "live", width: 1280, height: 720 })
    const shots = cdp.commands.filter((item) => item.method === "Page.captureScreenshot").length
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(cdp.commands.filter((item) => item.method === "Page.captureScreenshot").length).toBe(shots)

    cdp.commands.length = 0
    await session.resize(2, 800, 600)
    const burst = session.resize(2, 400, 300)
    await burst
    await new Promise((resolve) => setTimeout(resolve, 160))
    const metrics = cdp.commands.filter((item) => item.method === "Emulation.setDeviceMetricsOverride")
    expect(metrics.at(-1)?.params).toMatchObject({ width: 400, height: 300 })
    expect(cdp.commands.filter((item) => item.method === "Page.startScreencast").length).toBeLessThanOrEqual(2)
    await session.dispose()
  })

  // raya_change - resizing the panel drives the page's layout viewport (so CSS breakpoints fire
  // like a real browser) and maps pointer input against that live size.
  it("tracks the panel size as the layout viewport and maps input to it", async () => {
    const fake = harness()
    const session = new BrowserSession("test-profile", fake.launch)
    await session.ready()
    const cdp = fake.cdps[0]!

    cdp.commands.length = 0
    await session.resize(2, 640, 480)
    expect(cdp.commands.find((item) => item.method === "Emulation.setDeviceMetricsOverride")?.params).toMatchObject({
      width: 640,
      height: 480,
      deviceScaleFactor: 2,
    })
    expect(cdp.commands.filter((item) => item.method === "Page.startScreencast").at(-1)?.params).toMatchObject({
      maxWidth: 1280,
      maxHeight: 960,
    })

    // Normalized pointer coords now map against the 640×480 layout, not the 1280×720 launch viewport.
    cdp.commands.length = 0
    await session.pointer({ type: "mousePressed", x: 0.5, y: 0.5, button: "left", clickCount: 1 })
    expect(cdp.commands.find((item) => item.method === "Input.dispatchMouseEvent")?.params).toMatchObject({
      x: 320,
      y: 240,
    })
    await session.dispose()
  })

  it("reuses the persistent profile so login state survives a fresh browser session", async () => {
    const fake = harness()
    const first = new BrowserSession("persistent-profile", fake.launch)
    await first.execute({ operation: "evaluate", expression: "document.cookie='auth=logged-in'" })
    await first.dispose()

    const second = new BrowserSession("persistent-profile", fake.launch)
    const result = await second.execute({ operation: "evaluate", expression: "document.cookie" })

    expect(result.output).toBe("auth=logged-in")
    await second.dispose()
  })

  it("retries transient failures twice before succeeding on the third attempt", async () => {
    const fake = harness()
    const session = new BrowserSession("retry-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.failClicks = 2

    await session.execute({ operation: "click", selector: "#delayed" })

    expect(fake.pages[0]!.clickAttempts).toBe(3)
    expect(fake.pages[0]!.clicks).toEqual(["#delayed"])
    expect(session.current()).toEqual({ control: "agent", busy: false })
    await session.dispose()
  })

  it("backs off and retries HTTP rate-limit responses", async () => {
    const fake = harness()
    const session = new BrowserSession("rate-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.failNavigations = 2

    await session.execute({ operation: "navigate", url: "https://example.test/rate-limited" })

    expect(fake.pages[0]!.gotoAttempts).toBe(3)
    expect(session.current()).toEqual({ control: "agent", busy: false })
    await session.dispose()
  })

  it("keeps agent control after three failed clicks so the next tool can continue", async () => {
    const fake = harness()
    const session = new BrowserSession("retry-exhausted-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.failClicks = 3

    await expect(session.execute({ operation: "click", selector: "#missing" })).rejects.toThrow(
      "The click action failed after three attempts",
    )

    expect(fake.pages[0]!.clickAttempts).toBe(3)
    expect(session.current()).toEqual({ control: "agent", busy: false })
    fake.pages[0]!.failClicks = 0
    await session.execute({ operation: "click", selector: "#agent-resumed" })
    expect(fake.pages[0]!.clicks).toEqual(["#agent-resumed"])
    await session.dispose()
  })

  it("fails closed on a refused localhost URL without wedging takeover", async () => {
    const fake = harness()
    const session = new BrowserSession("refused-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.refuse = true

    await expect(session.execute({ operation: "navigate", url: "http://localhost:3000/" })).rejects.toThrow(
      /not reachable|connection refused/i,
    )
    expect(session.current()).toEqual({ control: "agent", busy: false })
    await session.dispose()
  })

  it("keeps the page after a hung navigation so a later goto can continue", async () => {
    const fake = harness()
    const session = new BrowserSession("timeout-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.hang = true

    await expect(
      session.execute({ operation: "navigate", url: "http://example.test/lessons/p0-03-the-sound-system" }),
    ).rejects.toThrow(/timed out|navigate action failed/i)
    expect(session.current()).toEqual({ control: "agent", busy: false })
    expect(fake.pages.length).toBe(1)
    fake.pages[0]!.hang = false
    await session.execute({ operation: "navigate", url: "http://example.test/" })
    expect(fake.pages[0]!.current).toBe("http://example.test/")
    expect(fake.pages[0]!.waitUntil).toBe("commit")
    await session.dispose()
  })

  it("does not reset the host when a click times out", async () => {
    const fake = harness()
    const session = new BrowserSession("click-timeout-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.hang = true
    fake.pages[0]!.failClicks = 3

    await expect(session.execute({ operation: "click", selector: "#continue" })).rejects.toThrow(
      /failed after three attempts/i,
    )
    expect(fake.pages.length).toBe(1)
    expect(session.current()).toEqual({ control: "agent", busy: false })
    await session.dispose()
  })

  it("reloads with commit and does not wait for full load", async () => {
    const fake = harness()
    const session = new BrowserSession("reload-profile", fake.launch)
    await session.ready()
    await session.reload()
    expect(fake.pages[0]!.waitUntil).toBe("commit")
    fake.pages[0]!.hang = true
    await session.reload()
    expect(session.current().control).toBe("agent")
    await session.dispose()
  })

  it("lets the user take control during an active attempt without further retries", async () => {
    const fake = harness()
    const session = new BrowserSession("interrupt-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.failClicks = 3
    const gate = Promise.withResolvers<void>()
    fake.pages[0]!.pause = gate.promise

    const action = session.execute({ operation: "click", selector: "#slow" })
    while (fake.pages[0]!.clickAttempts === 0) await Promise.resolve()
    session.takeControl()
    expect(session.current().busy).toBe(true)
    gate.resolve()
    await expect(action).rejects.toThrow()

    expect(fake.pages[0]!.clickAttempts).toBe(1)
    expect(session.current()).toEqual({
      control: "manual",
      busy: false,
      reason: "You took manual control of the browser.",
      attempts: undefined,
    })
    await session.dispose()
  })

  it("does not block agent actions on authentication or CAPTCHA pages", async () => {
    const fake = harness()
    const session = new BrowserSession("challenge-profile", fake.launch)

    await session.execute({ operation: "navigate", url: "https://example.test/login/captcha" })
    await session.execute({ operation: "click", selector: "input[type=password]" })

    expect(fake.pages[0]!.clickAttempts).toBe(1)
    expect(session.current()).toEqual({ control: "agent", busy: false })
    await session.dispose()
  })

  it("serializes parallel agent actions so browser input cannot collide", async () => {
    const fake = harness()
    const session = new BrowserSession("queue-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.delay = 20

    await Promise.all([
      session.execute({ operation: "click", selector: "#first" }),
      session.execute({ operation: "click", selector: "#second" }),
    ])

    expect(fake.pages[0]!.clicks).toEqual(["#first", "#second"])
    expect(fake.pages[0]!.maxActive).toBe(1)
    await session.dispose()
  })
})
