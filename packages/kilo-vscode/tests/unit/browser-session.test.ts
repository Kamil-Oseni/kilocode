// raya_change - Milestone F drive/watch, input forwarding, and login persistence
import { describe, expect, it } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  BrowserCDP,
  BrowserContextLike,
  BrowserLaunch,
  BrowserPage,
  BrowserResult,
} from "../../src/services/browser-automation/browser-session"
import { BrowserOutcomeError, BrowserSession, evaluate } from "../../src/services/browser-automation/browser-session"
import {
  ComputerUseLeaseStore,
  type AuthorizationRequest,
  type SensitivePolicy,
} from "../../src/services/computer-use/lease-store"

const policy: SensitivePolicy = {
  communications: "deny",
  financial: "deny",
  credentials: "deny",
  software: "deny",
  system: "deny",
  deletion: "deny",
  disclosure: "deny",
  legal: "deny",
  publishing: "deny",
}

async function authority(sessionID: string) {
  const saved: Record<string, unknown> = {}
  const lease = new ComputerUseLeaseStore({
    get: <T>(key: string) => saved[key] as T | undefined,
    update: async (key, value) => {
      saved[key] = value
    },
  })
  await lease.grant({
    sessionID,
    level: "autonomous",
    duration: "session",
    applications: "all",
    actions: ["browser"],
    sensitive: policy,
    cooperativeInput: false,
  })
  const request = {
    id: `authorize_${sessionID}`,
    sessionID,
    operation: "authorize",
    surface: "browser",
    action: "browser",
    sensitive: false,
  } satisfies AuthorizationRequest
  return {
    lease,
    guard: () => {
      const result = lease.authorize(request)
      if (result.decision !== "allow") throw new Error(result.reason)
    },
  }
}

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
  evaluation: Promise<unknown> | undefined
  onClick: (() => void) | undefined
  onFill: (() => void) | undefined
  active = 0
  maxActive = 0
  readonly fills: Array<{ selector: string; text: string }> = []
  readonly presses: string[] = []
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
    if (this.hang)
      throw new Error('page.reload: Timeout 30000ms exceeded.\nCall log:\n  - waiting for navigation until "load"')
    if (this.refuse) throw new Error("page.reload: Protocol error (Page.reload): Not attached to an active page")
  }
  async waitForTimeout(): Promise<void> {}
  async addInitScript(): Promise<void> {}

  locator(selector: string) {
    return {
      click: async () => {
        this.clickAttempts += 1
        this.onClick?.()
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
        this.onFill?.()
      },
      press: async (key: string) => {
        this.presses.push(`${selector}:${key}`)
      },
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
    if (this.evaluation) return (await this.evaluation) as R
    const input = typeof source === "string" ? source.replace(/^\(([\s\S]*)\)$/, "$1") : source
    const value = typeof input === "string" ? input.match(/^document\.cookie\s*=\s*["'](.+)["']$/)?.[1] : undefined
    if (value) {
      this.state.cookie = value
      return value as R
    }
    if (input === "document.cookie") return this.state.cookie as R
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
  it("parses before execution and never replays a runtime error in another wrapper", async () => {
    const key = "__raya_browser_effects"
    try {
      for (const source of [
        '(() => { globalThis.__raya_browser_effects++; throw new Error("after mutation") })',
        'globalThis.__raya_browser_effects++; throw new Error("after mutation")',
        'globalThis.__raya_browser_effects++; throw new SyntaxError("runtime syntax error")',
        'globalThis.__raya_browser_effects++; await Promise.reject(new Error("async failure")); return 1',
      ]) {
        Reflect.set(globalThis, key, 0)
        await expect(Promise.resolve().then(() => evaluate(source))).rejects.toThrow()
        expect(Reflect.get(globalThis, key)).toBe(1)
      }
      Reflect.set(globalThis, key, 0)
      expect(() => evaluate("globalThis.__raya_browser_effects++; ???")).toThrow(SyntaxError)
      expect(Reflect.get(globalThis, key)).toBe(0)
    } finally {
      Reflect.deleteProperty(globalThis, key)
    }
  })

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

  it("binds one grounded action to a fresh snapshot observation", async () => {
    const fake = harness()
    const session = new BrowserSession("observation-profile", fake.launch)

    await session.execute({ operation: "navigate", url: "https://example.test/form" })
    const snapshot = await session.execute({ operation: "snapshot" })
    expect(snapshot.observation).toMatchObject({
      version: 2,
      sequence: 1,
      sceneVersion: 1,
      target: { surface: "browser", location: "https://example.test/form" },
    })
    expect(snapshot.observation!.validUntil).toBeGreaterThan(snapshot.observation!.observedAt)

    await session.execute({
      operation: "click",
      tabID: snapshot.observation!.target.windowID,
      observationID: snapshot.observation!.id,
      selector: "#save",
    })
    await expect(
      session.execute({
        operation: "click",
        tabID: snapshot.observation!.target.windowID,
        observationID: snapshot.observation!.id,
        selector: "#save-again",
      }),
    ).rejects.toThrow(/unknown or was already used/i)
    expect(fake.pages[0]!.clicks).toEqual(["#save"])
    await session.dispose()
  })

  it("refuses an observation made stale by navigation or manual control before dispatch", async () => {
    const fake = harness()
    const session = new BrowserSession("stale-observation-profile", fake.launch)

    await session.execute({ operation: "navigate", url: "https://example.test/first" })
    const navigated = await session.execute({ operation: "snapshot" })
    fake.pages[0]!.current = "https://example.test/second"
    await expect(
      session.execute({
        operation: "click",
        tabID: navigated.observation!.target.windowID,
        observationID: navigated.observation!.id,
        selector: "#stale",
      }),
    ).rejects.toThrow(/stale after navigation/i)

    const controlled = await session.execute({ operation: "snapshot" })
    session.takeControl()
    await expect(
      session.execute({
        operation: "click",
        tabID: controlled.observation!.target.windowID,
        observationID: controlled.observation!.id,
        selector: "#manual",
      }),
    ).rejects.toThrow(/stale after manual control/i)
    expect(fake.pages[0]!.clicks).toEqual([])
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

  it("ignores obsolete authentication receipts and keeps normal browser storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-browser-live-"))
    const fake = harness()
    try {
      await writeFile(join(dir, "active-auth.json"), JSON.stringify({ captureID: "expired", status: "restored" }))
      const session = new BrowserSession(dir, fake.launch)
      await session.execute({ operation: "evaluate", expression: "document.cookie='auth=still-live'" })
      await expect(access(join(dir, "active-auth.json"))).rejects.toThrow()
      await session.dispose()

      const next = new BrowserSession(dir, fake.launch)
      const result = await next.execute({ operation: "evaluate", expression: "document.cookie" })
      expect(result.output).toBe("auth=still-live")
      await next.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("does not retry a click whose dispatch outcome is unknown", async () => {
    const fake = harness()
    const session = new BrowserSession("retry-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.failClicks = 2

    await expect(session.execute({ operation: "click", selector: "#delayed" })).rejects.toThrow("may have taken effect")

    expect(fake.pages[0]!.clickAttempts).toBe(1)
    expect(fake.pages[0]!.clicks).toEqual([])
    expect(session.current()).toEqual({ control: "agent", busy: false })
    await session.dispose()
  })

  it("preserves the destination instead of replaying dispatched rate-limited navigation", async () => {
    const fake = harness()
    const session = new BrowserSession("rate-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.failNavigations = 2

    await expect(session.execute({ operation: "navigate", url: "https://example.test/rate-limited" })).rejects.toThrow(
      "may have taken effect",
    )

    expect(fake.pages[0]!.gotoAttempts).toBe(1)
    expect(session.current()).toEqual({ control: "agent", busy: false })
    await session.dispose()
  })

  it("blocks a fresh request after the bridge marks an uncertain click until explicit resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-browser-uncertain-"))
    const fake = harness()
    const session = new BrowserSession(dir, fake.launch)
    await session.ready()
    fake.pages[0]!.failClicks = 3

    const failure = await session.execute({ operation: "click", selector: "#missing" }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BrowserOutcomeError)
    session.interlock((failure as Error).message)

    expect(fake.pages[0]!.clickAttempts).toBe(1)
    expect(session.current()).toMatchObject({ control: "manual", busy: false, reason: expect.stringContaining("may") })
    fake.pages[0]!.failClicks = 0
    await expect(session.execute({ operation: "click", selector: "#blocked" })).rejects.toThrow(/explicitly resume/i)
    expect(fake.pages[0]!.clickAttempts).toBe(1)
    session.resume()
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
    ).rejects.toThrow(/may have taken effect/i)
    expect(session.current()).toEqual({ control: "agent", busy: false })
    expect(fake.pages.length).toBe(1)
    fake.pages[0]!.hang = false
    await session.execute({ operation: "navigate", url: "http://example.test/" })
    expect(fake.pages[0]!.current).toBe("http://example.test/")
    expect(fake.pages[0]!.waitUntil).toBe("commit")
    await session.dispose()
  })

  it("replaces a runtime whose evaluation never settles and releases the action queue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-browser-timeout-"))
    const fake = harness()
    const session = new BrowserSession(dir, fake.launch, undefined, undefined, 500)
    try {
      await session.ready()
      fake.pages[0]!.evaluation = new Promise(() => undefined)

      await expect(session.execute({ operation: "evaluate", expression: "new Promise(() => {})" })).rejects.toThrow(
        /outcome is unknown.*restarted/i,
      )
      expect(session.current()).toEqual(
        expect.objectContaining({ control: "manual", busy: false, reason: expect.stringContaining("timed out") }),
      )

      await session.execute({ operation: "navigate", url: "https://example.test/recovered" })
      expect(fake.pages).toHaveLength(2)
      expect(fake.pages[1]!.current).toBe("https://example.test/recovered")
      expect(session.current()).toEqual({ control: "agent", busy: false })
    } finally {
      await session.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("does not reset the host when a click times out", async () => {
    const fake = harness()
    const session = new BrowserSession("click-timeout-profile", fake.launch)
    await session.ready()
    fake.pages[0]!.hang = true
    fake.pages[0]!.failClicks = 3

    await expect(session.execute({ operation: "click", selector: "#continue" })).rejects.toThrow(
      /may have taken effect/i,
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
    await expect(session.reload()).rejects.toThrow("may have taken effect")
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

  it("bounds queued panel tab actions without cancelling earlier tab requests", async () => {
    const fake = harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let native = 0
    const launch: BrowserLaunch = async (profile) => {
      const context = await fake.launch(profile)
      return {
        ...context,
        newPage: async () => {
          native += 1
          if (native === 1) {
            entered.resolve()
            await release.promise
          }
          return context.newPage()
        },
      }
    }
    const session = new BrowserSession("bounded-panel-tabs", launch)
    try {
      await session.ready()
      const first = session.tab("open")
      await entered.promise
      const queued = Array.from({ length: 7 }, () => session.tab("open"))
      await Bun.sleep(0)
      await expect(session.tab("open")).rejects.toThrow("queue is full")
      expect(native).toBe(1)
      release.resolve()
      await Promise.all([first, ...queued])
      expect(native).toBe(8)
    } finally {
      release.resolve()
      await session.dispose()
    }
  })

  it("does not dispatch a queued panel tab after manual takeover, but accepts a fresh one", async () => {
    const fake = harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let native = 0
    const launch: BrowserLaunch = async (profile) => {
      const context = await fake.launch(profile)
      return {
        ...context,
        newPage: async () => {
          native += 1
          if (native === 1) {
            entered.resolve()
            await release.promise
          }
          return context.newPage()
        },
      }
    }
    const session = new BrowserSession("stopped-panel-tabs", launch)
    try {
      await session.ready()
      const first = session.tab("open")
      await entered.promise
      const queued = session.tab("open")
      await Bun.sleep(0)
      session.takeControl()
      release.resolve()
      await first
      await expect(queued).rejects.toThrow("no action dispatched")
      expect(native).toBe(1)
      session.resume()
      await session.tab("open")
      expect(native).toBe(2)
    } finally {
      release.resolve()
      await session.dispose()
    }
  })

  it("does not dispatch an old queued panel tab after browser disposal", async () => {
    const fake = harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let native = 0
    const launch: BrowserLaunch = async (profile) => {
      const context = await fake.launch(profile)
      return {
        ...context,
        newPage: async () => {
          native += 1
          if (native === 1) {
            entered.resolve()
            await release.promise
          }
          return context.newPage()
        },
      }
    }
    const session = new BrowserSession("disposed-panel-tabs", launch)
    try {
      await session.ready()
      const first = session.tab("open").catch((error: unknown) => error)
      await entered.promise
      const queued = session.tab("open").catch((error: unknown) => error)
      await Bun.sleep(0)
      await session.dispose()
      release.resolve()
      await first
      expect(String(await queued)).toContain("no action dispatched")
      expect(native).toBe(1)
    } finally {
      release.resolve()
      await session.dispose()
    }
  })

  it("revalidates authority when a queued action reaches native dispatch", async () => {
    const fake = harness()
    const session = new BrowserSession("guarded-queue-profile", fake.launch)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let first: Promise<BrowserResult> | undefined
    let second: Promise<BrowserResult> | undefined
    let allowed = true
    const guard = () => {
      if (!allowed) throw new Error("Computer Use grant was revoked")
    }
    try {
      await session.ready()
      fake.pages[0]!.pause = release.promise
      fake.pages[0]!.onClick = () => entered.resolve()
      first = session.execute({ operation: "click", selector: "#first", guard })
      await Promise.race([
        entered.promise,
        Bun.sleep(2_000).then(() => {
          throw new Error("First queued browser action did not reach native dispatch")
        }),
      ])
      second = session.execute({ operation: "click", selector: "#second", guard })
      allowed = false
      release.resolve()

      await first
      await expect(second).rejects.toThrow("grant was revoked")
      expect(fake.pages[0]!.clickAttempts).toBe(1)
      expect(fake.pages[0]!.clicks).toEqual(["#first"])
    } finally {
      release.resolve()
      await Promise.allSettled([first, second].filter((item): item is Promise<BrowserResult> => !!item))
      await session.dispose()
    }
  })

  it("revalidates authority after filling and before submitting text", async () => {
    const fake = harness()
    const session = new BrowserSession("guarded-submit-profile", fake.launch)
    let allowed = true
    const guard = () => {
      if (!allowed) throw new Error("Computer Use grant was revoked after fill")
    }
    try {
      await session.ready()
      fake.pages[0]!.onFill = () => {
        allowed = false
      }
      const error = await session
        .execute({ operation: "type", selector: "#message", text: "Draft", submit: true, guard })
        .catch((value: unknown) => value)
      expect(error).toBeInstanceOf(BrowserOutcomeError)
      expect(String(error)).toContain("may have taken effect")
      expect(fake.pages[0]!.fills).toEqual([{ selector: "#message", text: "Draft" }])
      expect(fake.pages[0]!.presses).toEqual([])
    } finally {
      await session.dispose()
    }
  })

  it("refuses a revoked startup owner before profile mutation and leaves user startup retryable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-browser-startup-owner-"))
    const marker = join(dir, "active-auth.json")
    const fake = harness()
    const permit = await authority("session_startup_owner")
    const session = new BrowserSession(dir, fake.launch)
    let checks = 0
    let stopped: Promise<void> | undefined
    const guard = () => {
      checks++
      if (checks === 2) stopped = permit.lease.stop()
      permit.guard()
    }
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(marker, '{"captureID":"preserved","status":"restored"}')
      const before = await readFile(marker)

      const error = await session.execute({ operation: "tabs", action: "list", guard }).catch((value: unknown) => value)
      expect(error).not.toBeInstanceOf(BrowserOutcomeError)
      expect(String(error)).toContain("stopped")
      if (!stopped) throw new Error("Expected the startup lease to stop")
      await stopped
      expect(fake.pages).toHaveLength(0)
      expect(await readFile(marker)).toEqual(before)

      await session.ready()
      expect(fake.pages).toHaveLength(1)
    } finally {
      await session.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("lets a user-owned startup finish while a revoked joining action refuses locally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-browser-startup-joiner-"))
    const fake = harness()
    const permit = await authority("session_startup_joiner")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const joined = Promise.withResolvers<void>()
    const launch: BrowserLaunch = async (profile) => {
      entered.resolve()
      await release.promise
      return fake.launch(profile)
    }
    const session = new BrowserSession(dir, launch)
    let user: Promise<void> | undefined
    let action: Promise<BrowserResult> | undefined
    try {
      user = session.ready()
      await entered.promise
      action = session.execute({
        operation: "tabs",
        action: "list",
        guard: () => {
          permit.guard()
          joined.resolve()
        },
      })
      await joined.promise
      await permit.lease.stop()
      release.resolve()

      await user
      const error = await action.catch((value: unknown) => value)
      expect(error).not.toBeInstanceOf(BrowserOutcomeError)
      expect(String(error)).toContain("stopped")
      expect(fake.pages).toHaveLength(1)
      expect((await session.execute({ operation: "tabs", action: "list" })).tabs).toHaveLength(1)
    } finally {
      release.resolve()
      await Promise.allSettled([user, action].filter((item): item is Promise<unknown> => !!item))
      await session.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("closes a native context returned after startup authority is revoked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-browser-startup-launch-"))
    const fake = harness()
    const permit = await authority("session_startup_launch")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let closed = 0
    let pages = 0
    const launch: BrowserLaunch = async (profile) => {
      entered.resolve()
      await release.promise
      const context = await fake.launch(profile)
      return {
        ...context,
        newPage: async () => {
          pages++
          return context.newPage()
        },
        close: async () => {
          closed++
          await context.close()
        },
      }
    }
    const session = new BrowserSession(dir, launch)
    let action: Promise<BrowserResult> | undefined
    try {
      action = session.execute({ operation: "tabs", action: "list", guard: permit.guard })
      await entered.promise
      await permit.lease.stop()
      release.resolve()

      const error = await action.catch((value: unknown) => value)
      expect(error).toBeInstanceOf(BrowserOutcomeError)
      expect(String(error)).toContain("may have taken effect")
      expect(closed).toBe(1)
      expect(pages).toBe(0)
      expect(fake.pages).toHaveLength(1)
      expect(fake.pages[0]!.clickAttempts).toBe(0)
      expect(fake.pages[0]!.fills).toEqual([])
    } finally {
      release.resolve()
      await Promise.allSettled([action].filter((item): item is Promise<unknown> => !!item))
      await session.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("keeps startup outcome unknown and profile-owned when revoked context closure fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-browser-startup-close-"))
    const fake = harness()
    const permit = await authority("session_startup_close")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let closes = 0
    let foreign = 0
    const launch: BrowserLaunch = async (profile) => {
      entered.resolve()
      await release.promise
      const context = await fake.launch(profile)
      return {
        ...context,
        close: async () => {
          closes++
          if (closes === 1) throw new Error("Controlled native context close failure")
          await context.close()
        },
      }
    }
    const session = new BrowserSession(dir, launch)
    const other = new BrowserSession(dir, async (profile) => {
      foreign++
      return fake.launch(profile)
    })
    let action: Promise<BrowserResult> | undefined
    try {
      action = session.execute({ operation: "tabs", action: "list", guard: permit.guard })
      await entered.promise
      await permit.lease.stop()
      release.resolve()

      const error = await action.catch((value: unknown) => value)
      expect(error).toBeInstanceOf(BrowserOutcomeError)
      expect(String(error)).toContain("closure was not confirmed")
      expect(closes).toBe(1)
      await expect(other.ready()).rejects.toThrow("profile is in use")
      expect(foreign).toBe(0)
      await expect(session.execute({ operation: "tabs", action: "list" })).rejects.toThrow(
        "Authentication replacement was not confirmed",
      )
    } finally {
      release.resolve()
      await Promise.allSettled([action].filter((item): item is Promise<unknown> => !!item))
      await other.dispose()
      await session.dispose()
      await rm(dir, { recursive: true, force: true })
    }
    expect(closes).toBe(2)
  })

  it("retains uncertainty when revocation follows startup metadata removal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-browser-startup-partial-"))
    const marker = join(dir, "active-auth.json")
    const fake = harness()
    const permit = await authority("session_startup_partial")
    const session = new BrowserSession(dir, fake.launch)
    let checks = 0
    let stopped: Promise<void> | undefined
    const guard = () => {
      checks++
      if (checks === 3) stopped = permit.lease.stop()
      permit.guard()
    }
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(marker, '{"captureID":"removed","status":"restored"}')

      const error = await session.execute({ operation: "tabs", action: "list", guard }).catch((value: unknown) => value)
      if (!stopped) throw new Error("Expected the startup lease to stop")
      await stopped
      expect(error).toBeInstanceOf(BrowserOutcomeError)
      expect(String(error)).toContain("may have taken effect")
      expect(fake.pages).toHaveLength(0)
      await expect(access(marker)).rejects.toThrow()
      await expect(session.execute({ operation: "tabs", action: "list" })).rejects.toThrow(
        "Authentication replacement was not confirmed",
      )
    } finally {
      await session.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
