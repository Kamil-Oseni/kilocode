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

  async goto(url: string): Promise<{ status(): number }> {
    this.gotoAttempts += 1
    this.current = url
    return { status: () => (this.gotoAttempts <= this.failNavigations ? 429 : 200) }
  }

  async goBack(): Promise<void> {}
  async goForward(): Promise<void> {}
  async reload(): Promise<void> {}
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
        if (this.clickAttempts <= this.failClicks) throw new Error("element is not ready")
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

  async screenshot(): Promise<Buffer> {
    return Buffer.from("png")
  }

  async evaluate<R>(fn: (source: string) => R, source: string): Promise<R> {
    const value = source.match(/^document\.cookie\s*=\s*["'](.+)["']$/)?.[1]
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

  it("hands control to the user after three failed attempts and resumes explicitly", async () => {
    const fake = harness()
    const session = new BrowserSession("takeover-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.failClicks = 3

    await expect(session.execute({ operation: "click", selector: "#missing" })).rejects.toThrow(
      "Manual browser takeover required after three failed attempts",
    )

    expect(fake.pages[0]!.clickAttempts).toBe(3)
    expect(session.current()).toEqual({
      control: "manual",
      busy: false,
      reason: "The click action failed three times: element is not ready",
      attempts: 3,
    })
    await session.pointer({ type: "mousePressed", x: 0.5, y: 0.5, button: "left" })
    await session.navigate("https://example.org")
    expect(fake.pages[0]!.current).toBe("https://example.org")
    await session.execute({ operation: "click", selector: "#agent-resumed" })
    expect(fake.pages[0]!.clicks).toEqual(["#agent-resumed"])
    expect(session.current()).toEqual({ control: "agent", busy: false })
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
