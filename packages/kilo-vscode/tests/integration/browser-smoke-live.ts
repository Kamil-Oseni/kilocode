// raya_change - Milestone G live Node/Playwright authenticated walkthrough verification
import assert from "node:assert/strict"
import { access, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserSession } from "../../src/services/browser-automation/browser-session"

const app = { broken: false }
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  if (url.pathname === "/login") {
    response.setHeader("content-type", "text/html")
    response.end('<!doctype html><form action="/auth"><button id="login">Sign in as Eden</button></form>')
    return
  }
  if (url.pathname === "/auth") {
    response.statusCode = 302
    response.setHeader("location", "/app")
    response.setHeader("set-cookie", "raya_auth=eden; Path=/; HttpOnly; SameSite=Lax")
    response.end()
    return
  }
  if (url.pathname === "/api/health") {
    response.statusCode = app.broken ? 500 : 200
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ ok: !app.broken }))
    return
  }
  if (url.pathname === "/app") {
    if (!request.headers.cookie?.includes("raya_auth=eden")) {
      response.statusCode = 401
      response.end('<h1 id="signed-out">Sign in required</h1>')
      return
    }
    response.setHeader("content-type", "text/html")
    response.end(
      '<!doctype html><h1 id="welcome">Welcome Eden</h1><script>fetch("/api/health").then(r => console.info("health:" + r.status))</script>',
    )
    return
  }
  response.statusCode = 404
  response.end("Not found")
})

async function main() {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Sample app did not bind a TCP port")
  const origin = `http://127.0.0.1:${address.port}`
  const root = await mkdtemp(join(tmpdir(), "raya-smoke-live-"))
  const artifacts = join(root, "artifacts")
  const authSession = new BrowserSession(join(root, "auth-profile"), undefined, artifacts)
  const runSession = new BrowserSession(join(root, "fresh-profile"), undefined, artifacts)

  try {
    await authSession.execute({ operation: "navigate", url: `${origin}/login` })
    await authSession.execute({ operation: "click", selector: "#login" })
    const auth = await authSession.execute({ operation: "auth_capture", name: "sample-app" })
    assert.equal(auth.operation, "auth_capture")
    if (auth.operation !== "auth_capture") throw new Error("Expected auth capture result")
    assert.ok(auth.cookies > 0)
    await access(auth.path)
    await authSession.dispose()

    const flow = {
      operation: "smoke" as const,
      name: "sample-app",
      mode: "scripted" as const,
      steps: [
        {
          id: "dashboard",
          title: "Authenticated dashboard is healthy",
          action: { kind: "navigate" as const, url: `${origin}/app` },
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

    const passing = await runSession.execute(flow)
    assert.equal(passing.operation, "smoke")
    if (passing.operation !== "smoke") throw new Error("Expected smoke result")
    assert.equal(passing.passed, true)
    assert.equal(passing.steps.length, 2)
    for (const step of passing.steps) await access(step.screenshot)
    await access(passing.artifact)

    app.broken = true
    const broken = await runSession.execute(flow)
    assert.equal(broken.operation, "smoke")
    if (broken.operation !== "smoke") throw new Error("Expected smoke result")
    assert.equal(broken.passed, false)
    assert.equal(broken.failingStep, "dashboard")
    assert.equal(broken.steps[0]?.assertions.find((item) => item.kind === "network")?.passed, false)
    console.log(
      JSON.stringify({
        authenticated: auth.cookies > 0,
        passing: { passed: passing.passed, artifact: passing.artifact },
        broken: { passed: broken.passed, failingStep: broken.failingStep, artifact: broken.artifact },
      }),
    )
  } finally {
    await authSession.dispose()
    await runSession.dispose()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      }),
    )
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
