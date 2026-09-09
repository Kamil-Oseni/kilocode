// raya_change - Milestone G authenticated smoke walkthrough runner and evidence artifacts
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { FrameRegistry } from "./browser-frame"
import { describe, locate, TargetError, type BrowserTarget, type TargetPage } from "./browser-target"
import type { AuthSource } from "./browser-auth"

export type SmokeAction =
  | { kind: "navigate"; url: string }
  | { frameID?: string; kind: "click"; selector: BrowserTarget }
  | { frameID?: string; kind: "type"; selector: BrowserTarget; text: string; submit?: boolean }
  | { frameID?: string; kind: "select"; selector: BrowserTarget; values: string[] }

export type SmokeAssertion =
  | { frameID?: string; kind: "visible"; selector: BrowserTarget; text?: string }
  | { kind: "network"; url: string; status?: number }
  | { kind: "console"; level?: "error" | "warning" | "log" | "info"; message?: string; max: number }

export type SmokeStep = {
  id: string
  title: string
  action?: SmokeAction
  assertions: SmokeAssertion[]
}

export type SmokeInput = {
  name: string
  mode: "scripted" | "exploratory"
  steps: SmokeStep[]
}

export type SmokeFinding = {
  url?: string
  status?: number
  level?: string
  message?: string
}

export type SmokeAssertionResult = {
  frameID?: string
  scope?: "frame" | "tab"
  kind: SmokeAssertion["kind"]
  passed: boolean
  expected: string
  actual: string
}

export type SmokeStepResult = {
  screenshotScope?: "tab"
  id: string
  title: string
  passed: boolean
  screenshot: string
  assertions: SmokeAssertionResult[]
  error?: string
}

export type SmokeResult = {
  tabID?: string
  operation: "smoke"
  runID: string
  name: string
  mode: SmokeInput["mode"]
  passed: boolean
  startedAt: number
  finishedAt: number
  artifact: string
  authState: string
  authentication: AuthSource
  failingStep?: string
  steps: SmokeStepResult[]
  network: SmokeFinding[]
  console: SmokeFinding[]
}

export interface SmokeResponse {
  url(): string
  status(): number
}

export interface SmokeConsole {
  type(): string
  text(): string
}

export interface SmokePage extends TargetPage {
  goto(url: string, options?: { timeout?: number; waitUntil?: "load" }): Promise<unknown>
  waitForTimeout(timeout: number): Promise<void>
  addInitScript<A>(script: (arg: A) => void, arg: A): Promise<void>
  locator(selector: string): {
    click(options?: { timeout?: number }): Promise<void>
    fill(text: string, options?: { timeout?: number }): Promise<void>
    press(key: string, options?: { timeout?: number }): Promise<void>
    selectOption(values: string[], options?: { timeout?: number }): Promise<unknown>
    isVisible(options?: { timeout?: number }): Promise<boolean>
    textContent(options?: { timeout?: number }): Promise<string | null>
  }
  screenshot(options: { type: "png"; fullPage: boolean; path: string }): Promise<Buffer>
  on(event: "response", listener: (response: SmokeResponse) => void): void
  on(event: "console", listener: (message: SmokeConsole) => void): void
  off(event: "response", listener: (response: SmokeResponse) => void): void
  off(event: "console", listener: (message: SmokeConsole) => void): void
}

export interface SmokeContext {
  storageState(options: { path: string; indexedDB?: boolean }): Promise<{
    cookies: SmokeCookie[]
    origins: SmokeOrigin[]
  }>
  addCookies(cookies: SmokeCookie[]): Promise<void>
}

export type SmokeCookie = {
  name: string
  value: string
  url?: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: "Strict" | "Lax" | "None"
}

export type SmokeOrigin = {
  origin: string
  localStorage: Array<{ name: string; value: string }>
}

const safe = (value: string) =>
  value
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "") || "run"
const text = (value: unknown) => (value instanceof Error ? value.message : String(value))

export class BrowserSmoke {
  constructor(
    private readonly root: string,
    private readonly page: SmokePage,
    _context: SmokeContext,
    private readonly frames?: (id: string) => ReturnType<FrameRegistry["lease"]>,
    private readonly tabID?: string,
    private readonly authentication: AuthSource = { source: "live", profileID: root, login: "unverified" },
  ) {}

  async run(input: SmokeInput): Promise<SmokeResult> {
    const kinds = input.steps.flatMap((step) => step.assertions.map((assertion) => assertion.kind))
    if (!kinds.includes("visible")) throw new Error("Smoke flows require at least one visible-state assertion.")
    if (!kinds.includes("network") && !kinds.includes("console"))
      throw new Error("Smoke flows require at least one network or console assertion.")

    const runID = `${Date.now()}-${crypto.randomUUID()}`
    const dir = join(this.root, "runs", safe(input.name), runID)
    const artifact = join(dir, "report.json")
    await mkdir(dir, { recursive: true })
    const network: SmokeFinding[] = []
    const console: SmokeFinding[] = []
    const response = (item: SmokeResponse) => network.push({ url: item.url(), status: item.status() })
    const message = (item: SmokeConsole) => console.push({ level: item.type(), message: item.text() })
    this.page.on("response", response)
    this.page.on("console", message)
    const startedAt = Date.now()
    const steps: SmokeStepResult[] = []

    try {
      for (const [index, step] of input.steps.entries()) {
        const screenshot = join(dir, `${String(index + 1).padStart(2, "0")}-${safe(step.id)}.png`)
        const networkStart = network.length
        const consoleStart = console.length
        const result = await this.step(step, screenshot, network, console, networkStart, consoleStart).catch(
          async (error: unknown) => {
            await this.page.screenshot({ type: "png", fullPage: true, path: screenshot }).catch(() => Buffer.alloc(0))
            return {
              id: step.id,
              title: step.title,
              passed: false,
              screenshot,
              screenshotScope: "tab",
              assertions: [],
              error: text(error),
            } satisfies SmokeStepResult
          },
        )
        steps.push(result)
        if (!result.passed) break
      }
    } finally {
      this.page.off("response", response)
      this.page.off("console", message)
    }

    const failing = steps.find((step) => !step.passed)
    const report: SmokeResult = {
      operation: "smoke",
      tabID: this.tabID,
      runID,
      name: input.name,
      mode: input.mode,
      passed: !failing && steps.length === input.steps.length,
      startedAt,
      finishedAt: Date.now(),
      artifact,
      authState: this.authentication.captureID ?? "live",
      authentication: this.authentication,
      failingStep: failing?.id,
      steps,
      network,
      console,
    }
    await writeFile(artifact, JSON.stringify(report, null, 2))
    return report
  }

  private async step(
    step: SmokeStep,
    screenshot: string,
    network: SmokeFinding[],
    console: SmokeFinding[],
    networkStart: number,
    consoleStart: number,
  ): Promise<SmokeStepResult> {
    await this.action(step.action)
    const assertions: SmokeAssertionResult[] = []
    for (const assertion of step.assertions)
      assertions.push(await this.assert(assertion, network.slice(networkStart), console.slice(consoleStart)))
    await this.page.screenshot({ type: "png", fullPage: true, path: screenshot })
    return {
      id: step.id,
      title: step.title,
      passed: assertions.every((assertion) => assertion.passed),
      screenshot,
      screenshotScope: "tab",
      assertions,
    }
  }

  private async action(action?: SmokeAction): Promise<void> {
    if (!action) return
    if (action.kind === "navigate") {
      await this.page.goto(action.url, { timeout: 15_000, waitUntil: "load" })
      await this.page.waitForTimeout(250)
      return
    }
    const lease = action.frameID !== undefined ? this.frames?.(action.frameID) : undefined
    if (action.frameID !== undefined && !lease) throw new TargetError("Smoke frame identity is unavailable")
    const locator = lease ? await lease.element(action.selector) : await locate(this.page, action.selector)
    try {
      lease?.check()
      if (action.kind === "click") await locator.click({ timeout: 5_000 })
      if (action.kind === "type") {
        await locator.fill(action.text, { timeout: 5_000 })
        lease?.check()
        if (action.submit === true) await locator.press("Enter", { timeout: 5_000 })
      }
      if (action.kind === "select") await locator.selectOption(action.values, { timeout: 5_000 })
      lease?.check()
    } finally {
      if (lease && "dispose" in locator && typeof locator.dispose === "function") await locator.dispose()
    }
  }

  private async visible(assertion: Extract<SmokeAssertion, { kind: "visible" }>): Promise<SmokeAssertionResult> {
    const lease = assertion.frameID !== undefined ? this.frames?.(assertion.frameID) : undefined
    if (assertion.frameID !== undefined && !lease) throw new TargetError("Smoke frame identity is unavailable")
    const locator = lease ? await lease.element(assertion.selector) : await locate(this.page, assertion.selector)
    try {
      const visible = await locator.isVisible({ timeout: 5_000 })
      const content = visible ? await locator.textContent({ timeout: 5_000 }) : null
      lease?.check()
      const passed = visible && (assertion.text === undefined || content?.includes(assertion.text) === true)
      return {
        kind: assertion.kind,
        frameID: lease?.id,
        scope: lease ? "frame" : "tab",
        passed,
        expected: assertion.text
          ? `${describe(assertion.selector)} contains "${assertion.text}"`
          : `${describe(assertion.selector)} is visible`,
        actual: visible ? `visible: ${content ?? ""}` : "not visible",
      }
    } finally {
      if (lease && "dispose" in locator && typeof locator.dispose === "function") await locator.dispose()
    }
  }

  private async assert(
    assertion: SmokeAssertion,
    network: SmokeFinding[],
    console: SmokeFinding[],
  ): Promise<SmokeAssertionResult> {
    if (assertion.kind === "visible") return this.visible(assertion)
    if (assertion.kind === "network") {
      const matches = network.filter(
        (item) =>
          item.url?.includes(assertion.url) && (assertion.status === undefined || item.status === assertion.status),
      )
      return {
        kind: assertion.kind,
        scope: "tab",
        passed: matches.length > 0,
        expected: `${assertion.url}${assertion.status === undefined ? "" : ` status ${assertion.status}`}`,
        actual: matches.length > 0 ? JSON.stringify(matches) : "no matching response",
      }
    }
    const matches = console.filter(
      (item) =>
        (assertion.level === undefined || item.level === assertion.level) &&
        (assertion.message === undefined || item.message?.includes(assertion.message)),
    )
    return {
      kind: assertion.kind,
      scope: "tab",
      passed: matches.length <= assertion.max,
      expected: `at most ${assertion.max} matching console message(s)`,
      actual: `${matches.length}: ${JSON.stringify(matches)}`,
    }
  }
}
