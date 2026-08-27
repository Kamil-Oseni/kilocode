// raya_change - Milestone G deterministic passing and broken-state smoke runner suite
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BrowserSmoke,
  type SmokeConsole,
  type SmokePage,
  type SmokeResponse,
} from "../../src/services/browser-automation/browser-smoke"

class SamplePage implements SmokePage {
  signedIn = false
  broken = false
  current = "/login"
  private readonly responses = new Set<(response: SmokeResponse) => void>()
  private readonly messages = new Set<(message: SmokeConsole) => void>()

  async goto(url: string): Promise<void> {
    this.current = new URL(url).pathname
    if (this.current !== "/app") return
    const status = this.broken ? 500 : 200
    for (const listener of this.responses)
      listener({ url: () => "https://sample.test/api/health", status: () => status })
    for (const listener of this.messages) listener({ type: () => "info", text: () => `health:${status}` })
  }

  async waitForTimeout(): Promise<void> {}
  async addInitScript(): Promise<void> {}

  locator(selector: string) {
    return {
      click: async () => {
        if (selector === "#login") this.signedIn = true
      },
      fill: async () => undefined,
      press: async () => undefined,
      selectOption: async () => undefined,
      isVisible: async () => selector === "#welcome" && this.current === "/app" && this.signedIn,
      textContent: async () => (selector === "#welcome" ? "Welcome Eden" : null),
    }
  }

  async screenshot(options: { path: string }): Promise<Buffer> {
    const data = Buffer.from("png")
    await writeFile(options.path, data)
    return data
  }

  on(event: "response" | "console", listener: ((response: SmokeResponse) => void) | ((message: SmokeConsole) => void)) {
    if (event === "response") this.responses.add(listener as (response: SmokeResponse) => void)
    if (event === "console") this.messages.add(listener as (message: SmokeConsole) => void)
  }

  off(
    event: "response" | "console",
    listener: ((response: SmokeResponse) => void) | ((message: SmokeConsole) => void),
  ) {
    if (event === "response") this.responses.delete(listener as (response: SmokeResponse) => void)
    if (event === "console") this.messages.delete(listener as (message: SmokeConsole) => void)
  }
}

const paths = { root: "", artifacts: "" }

beforeAll(async () => {
  paths.root = await mkdtemp(join(tmpdir(), "raya-smoke-unit-"))
  paths.artifacts = join(paths.root, "artifacts")
  await mkdir(paths.artifacts, { recursive: true })
})

afterAll(async () => {
  await rm(paths.root, { recursive: true, force: true })
})

describe("Raya authenticated smoke runner", () => {
  it("returns green evidence and identifies the deliberately broken step", async () => {
    const page = new SamplePage()
    const smoke = new BrowserSmoke(paths.artifacts, page, {
      storageState: async ({ path }) => {
        const state = { cookies: page.signedIn ? [{ name: "raya_auth", value: "eden" }] : [], origins: [] }
        await writeFile(path, JSON.stringify(state))
        return state
      },
      addCookies: async (cookies) => {
        page.signedIn = cookies.some((cookie) => cookie.name === "raya_auth" && cookie.value === "eden")
      },
    })
    await page.locator("#login").click()
    const auth = await smoke.capture("sample-app")
    expect(auth.cookies).toBe(1)
    expect(await Bun.file(auth.path).exists()).toBe(true)
    page.signedIn = false

    const flow = {
      name: "sample-app",
      mode: "scripted" as const,
      steps: [
        {
          id: "dashboard",
          title: "Authenticated dashboard is healthy",
          action: { kind: "navigate" as const, url: "https://sample.test/app" },
          assertions: [
            { kind: "visible" as const, selector: "#welcome", text: "Welcome Eden" },
            { kind: "network" as const, url: "/api/health", status: 200 },
          ],
        },
        {
          id: "identity",
          title: "Logged-in identity remains visible",
          assertions: [
            { kind: "visible" as const, selector: "#welcome", text: "Welcome Eden" },
            { kind: "console" as const, level: "error" as const, max: 0 },
          ],
        },
      ],
    }

    page.signedIn = true
    const automatic = await smoke.run({ ...flow, name: "automatic-app", mode: "exploratory" })
    expect(automatic.passed).toBe(true)
    expect(await Bun.file(join(paths.artifacts, "auth", "automatic-app.json")).exists()).toBe(true)

    page.signedIn = false
    const passing = await smoke.run(flow)
    expect(passing.passed).toBe(true)
    expect(page.signedIn).toBe(true)
    expect(passing.steps).toHaveLength(2)
    expect(passing.steps[0]?.assertions.map((item) => item.kind)).toEqual(["visible", "network"])
    expect(passing.steps[1]?.assertions.map((item) => item.kind)).toEqual(["visible", "console"])
    expect((await Promise.all(passing.steps.map((step) => Bun.file(step.screenshot).exists()))).every(Boolean)).toBe(
      true,
    )
    expect(await Bun.file(passing.artifact).exists()).toBe(true)

    const exploratory = await smoke.run({ ...flow, mode: "exploratory" })
    expect(exploratory.mode).toBe("exploratory")
    expect(exploratory.passed).toBe(true)

    page.broken = true
    const broken = await smoke.run(flow)
    expect(broken.passed).toBe(false)
    expect(broken.failingStep).toBe("dashboard")
    expect(broken.steps[0]?.assertions.find((item) => item.kind === "network")?.passed).toBe(false)
  })
})
