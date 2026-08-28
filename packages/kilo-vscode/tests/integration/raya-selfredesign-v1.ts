// raya_change - Goal 1 named browser smoke run with one screenshot per rendered state
import assert from "node:assert/strict"
import { access, mkdir, rm } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { join } from "node:path"
import { BrowserSession } from "../../src/services/browser-automation/browser-session"

const origin = "http://localhost:5199"
const themes = ["light", "dark"] as const
const states = [
  "default",
  "hover",
  "focus",
  "pressed",
  "disabled",
  "expanded",
  "editing",
  "discard",
  "discard-busy",
  "usage",
  "paused",
  "complete",
  "blocked",
  "notice",
] as const
const root = join(process.cwd(), "test-results", "raya-selfredesign-v1")

async function ready() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(origin).catch(() => undefined)
    if (response?.ok) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Preview did not become ready at ${origin}`)
}

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true })
    await new Promise<void>((resolve) => killer.once("exit", () => resolve()))
    return
  }
  child.kill("SIGTERM")
  await new Promise<void>((resolve) => child.once("exit", () => resolve()))
}

async function main() {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await mkdir(root, { recursive: true })
  const server = spawn("bun", ["webview-ui/preview/serve.cjs"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  const browser = new BrowserSession(join(root, "profile"), undefined, join(root, "artifacts"))

  try {
    await ready()
    const steps = themes.flatMap((theme) =>
      states.map((state) => {
        const id = `${theme}-${state}`
        return {
          id,
          title: `${theme} ${state} goal banner renders`,
          action: { kind: "navigate" as const, url: `${origin}/?state=${id}` },
          assertions: [
            { kind: "visible" as const, selector: `[data-fixture="${id}"]`, text: `${theme} · ${state}` },
            {
              kind: "visible" as const,
              selector: `[data-fixture="${id}"] ${state === "usage" ? ".usage-history" : ".goal-banner"}`,
            },
            { kind: "console" as const, level: "error" as const, max: 0 },
          ],
        }
      }),
    )
    const result = await browser.execute({
      operation: "smoke",
      name: "raya-selfredesign-v1",
      mode: "scripted",
      steps,
    })
    assert.equal(result.operation, "smoke")
    if (result.operation !== "smoke") throw new Error("Expected smoke result")
    assert.equal(result.passed, true, result.failingStep)
    assert.equal(result.steps.length, steps.length)
    for (const step of result.steps) await access(step.screenshot)
    await access(result.artifact)
    console.log(JSON.stringify({ passed: result.passed, artifact: result.artifact, screenshots: result.steps.length }))
  } finally {
    await browser.dispose()
    await stop(server)
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
