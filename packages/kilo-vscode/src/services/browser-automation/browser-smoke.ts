// raya_change - Milestone G authenticated smoke walkthrough runner and evidence artifacts
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type SmokeAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string; submit?: boolean }
  | { kind: "select"; selector: string; values: string[] }

export type SmokeAssertion =
  | { kind: "visible"; selector: string; text?: string }
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
  kind: SmokeAssertion["kind"]
  passed: boolean
  expected: string
  actual: string
}

export type SmokeStepResult = {
  id: string
  title: string
  passed: boolean
  screenshot: string
  assertions: SmokeAssertionResult[]
  error?: string
}

export type SmokeResult = {
  operation: "smoke"
  runID: string
  name: string
  mode: SmokeInput["mode"]
  passed: boolean
  startedAt: number
  finishedAt: number
  artifact: string
  authState: string
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

export interface SmokePage {
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
    private readonly context: SmokeContext,
  ) {}

  async capture(name: string) {
    const dir = join(this.root, "auth")
    const path = join(dir, `${safe(name)}.json`)
    await mkdir(dir, { recursive: true })
    const state = await this.context.storageState({ path, indexedDB: true })
    return {
      operation: "auth_capture" as const,
      name,
      path,
      cookies: state.cookies.length,
      origins: state.origins.length,
    }
  }

  async run(input: SmokeInput): Promise<SmokeResult> {
    const kinds = input.steps.flatMap((step) => step.assertions.map((assertion) => assertion.kind))
    if (!kinds.includes("visible")) throw new Error("Smoke flows require at least one visible-state assertion.")
    if (!kinds.includes("network") && !kinds.includes("console"))
      throw new Error("Smoke flows require at least one network or console assertion.")

    const authState = join(this.root, "auth", `${safe(input.name)}.json`)
    // Plain-English walkthroughs should not require the user to remember a separate auth-capture tool.
    const state = await readFile(authState, "utf8").catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await this.capture(input.name)
      return readFile(authState, "utf8")
    })
    const saved = JSON.parse(state) as {
      cookies?: SmokeCookie[]
      origins?: SmokeOrigin[]
    }
    if (!Array.isArray(saved.cookies) || !Array.isArray(saved.origins))
      throw new Error(`Authenticated storage state for "${input.name}" is invalid.`)
    await this.context.addCookies(saved.cookies)
    await this.page.addInitScript((origins) => {
      const saved = origins.find((item) => item.origin === location.origin)
      for (const item of saved?.localStorage ?? []) localStorage.setItem(item.name, item.value)
    }, saved.origins)

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
      runID,
      name: input.name,
      mode: input.mode,
      passed: !failing && steps.length === input.steps.length,
      startedAt,
      finishedAt: Date.now(),
      artifact,
      authState,
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
    const locator = this.page.locator(action.selector)
    if (action.kind === "click") {
      await locator.click({ timeout: 5_000 })
      return
    }
    if (action.kind === "type") {
      await locator.fill(action.text, { timeout: 5_000 })
      if (action.submit === true) await locator.press("Enter", { timeout: 5_000 })
      return
    }
    await locator.selectOption(action.values, { timeout: 5_000 })
  }

  private async assert(
    assertion: SmokeAssertion,
    network: SmokeFinding[],
    console: SmokeFinding[],
  ): Promise<SmokeAssertionResult> {
    if (assertion.kind === "visible") {
      const locator = this.page.locator(assertion.selector)
      const visible = await locator.isVisible({ timeout: 5_000 })
      const content = visible ? await locator.textContent({ timeout: 5_000 }) : null
      const passed = visible && (assertion.text === undefined || content?.includes(assertion.text) === true)
      return {
        kind: assertion.kind,
        passed,
        expected: assertion.text
          ? `${assertion.selector} contains "${assertion.text}"`
          : `${assertion.selector} is visible`,
        actual: visible ? `visible: ${content ?? ""}` : "not visible",
      }
    }
    if (assertion.kind === "network") {
      const matches = network.filter(
        (item) =>
          item.url?.includes(assertion.url) && (assertion.status === undefined || item.status === assertion.status),
      )
      return {
        kind: assertion.kind,
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
      passed: matches.length <= assertion.max,
      expected: `at most ${assertion.max} matching console message(s)`,
      actual: `${matches.length}: ${JSON.stringify(matches)}`,
    }
  }
}
