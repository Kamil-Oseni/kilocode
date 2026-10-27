import { test } from "bun:test"
import { build } from "esbuild"
import { chromium, expect } from "@playwright/test"
import { transformAsync } from "@babel/core"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
const require = createRequire(import.meta.url)

async function compile() {
  const root = resolve(import.meta.dir, "../..")
  const dir = resolve(root, "node_modules/.cache/session-queue-mounted")
  const solid = dirname(require.resolve("solid-js/package.json"))
  await build({
    absWorkingDir: root,
    tsconfig: resolve(root, "webview-ui/tsconfig.json"),
    entryPoints: [resolve(root, "tests/fixtures/session-queue-mounted.jsx")],
    outdir: dir,
    bundle: true,
    platform: "browser",
    format: "iife",
    conditions: ["browser"],
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "file" },
    plugins: [
      {
        name: "actual-solid",
        setup(build) {
          build.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => ({
            path: resolve(
              solid,
              args.path === "solid-js"
                ? "dist/solid.js"
                : args.path === "solid-js/web"
                  ? "web/dist/web.js"
                  : "store/dist/store.js",
            ),
          }))
          build.onResolve({ filter: /\?worker&url$/ }, () => ({ path: "worker", namespace: "fixture" }))
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export default 'unused-worker.js'",
            loader: "js",
          }))
          build.onResolve({ filter: /^@/, namespace: "file" }, (args) =>
            args.kind === "import-rule"
              ? build.resolve(args.path, { kind: "import-statement", resolveDir: args.resolveDir })
              : undefined,
          )
          build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
            const result = await transformAsync(await Bun.file(args.path).text(), {
              filename: args.path,
              configFile: false,
              babelrc: false,
              presets: [
                [require("babel-preset-solid"), {}],
                [require("@babel/preset-typescript"), {}],
              ],
            })
            if (!result?.code) throw new Error("Actual component compilation failed")
            return { contents: result.code, loader: "js" }
          })
        },
      },
    ],
  })
  return dir
}

test("mounted terminal parent reconciles stale queue while retaining newer pending prompts", async () => {
  const dir = await compile()
  const browser = await chromium.launch({ headless: true, channel: "msedge" })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (err) => errors.push(err.message))
  try {
    await Bun.write(resolve(dir, "index.html"), '<div id="root"></div>')
    await page.goto(pathToFileURL(resolve(dir, "index.html")).href)
    await page.addScriptTag({ path: resolve(dir, "session-queue-mounted.js") })
    await page.evaluate(async () => {
      await window.__deliver({ type: "sessionCreated", session: { id: "ses_queue", title: "Queue regression" } })
      window.__session.setCurrentSessionID("ses_queue")
    })
    const user = {
      id: "msg_1",
      sessionID: "ses_queue",
      role: "user",
      time: { created: 1 },
      parts: [
        { id: "prt_1", messageID: "msg_1", sessionID: "ses_queue", type: "text", text: "Synthetic completed prompt" },
      ],
    }
    const next = {
      ...user,
      id: "msg_3",
      time: { created: 3 },
      parts: [{ ...user.parts[0], id: "prt_3", messageID: "msg_3", text: "Synthetic pending prompt" }],
    }
    await page.evaluate(
      async ({ user, next }) => {
        await window.__deliver({ type: "messagesLoaded", sessionID: "ses_queue", messages: [user, next] })
        await window.__deliver({ type: "sessionStatus", sessionID: "ses_queue", status: "busy" })
        await window.__deliver({ type: "sessionQueueChanged", sessionID: "ses_queue", queued: [user.id, next.id] })
      },
      { user, next },
    )
    await expect.poll(() => page.evaluate(() => window.__session.queuedMessages())).toEqual(["msg_1", "msg_3"])
    const assistant = {
      id: "msg_2",
      sessionID: "ses_queue",
      role: "assistant",
      parentID: "msg_1",
      time: { created: 2 },
      finish: "tool-calls",
      parts: [],
    }
    await page.evaluate((message) => window.__deliver({ type: "messageCreated", message }), assistant)
    await expect.poll(() => page.evaluate(() => window.__session.queuedMessages())).toEqual(["msg_1", "msg_3"])
    await page.evaluate((message) => window.__deliver({ type: "messageCreated", message }), {
      ...assistant,
      finish: undefined,
    })
    expect(await page.evaluate(() => window.__session.queuedMessages())).toEqual(["msg_1", "msg_3"])
    const final = { ...assistant, finish: "stop", time: { created: 2, completed: 4 } }
    await page.evaluate((message) => window.__deliver({ type: "messageCreated", message }), final)
    await expect.poll(() => page.evaluate(() => window.__session.queuedMessages())).toEqual(["msg_3"])
    expect(await page.locator('[data-message="msg_1"]').ariaSnapshot()).not.toContain("Queued")
    expect(await page.locator('[data-message="msg_3"]').ariaSnapshot()).toContain("Queued")
    await page.evaluate(() => window.__deliver({ type: "sessionStatus", sessionID: "ses_queue", status: "idle" }))
    expect(await page.evaluate(() => window.__session.queuedMessages())).toEqual(["msg_3"])
    await page.evaluate(
      (messages) => window.__deliver({ type: "messagesLoaded", sessionID: "ses_queue", messages }),
      [user, final, next],
    )
    expect(await page.evaluate(() => window.__session.queuedMessages())).toEqual(["msg_3"])
    await expect(page.locator('[data-message="msg_1"] [data-slot="user-message-text"][data-queued]')).toHaveCount(0)
    expect(
      await page
        .locator('[data-message="msg_1"] [data-slot="user-message-queued-indicator"]')
        .evaluate((node) => node.parentElement.parentElement.style.height),
    ).toBe("0px")
    await expect(page.locator('[data-message="msg_3"] [data-slot="user-message-text"][data-queued]')).toHaveCount(1)
    // Closed animation content remains mounted. Its stale status must also
    // leave the browser accessibility tree, while real queued work stays exposed.
    expect(await page.locator('[data-message="msg_1"]').ariaSnapshot()).not.toContain("Queued")
    expect(await page.locator('[data-message="msg_3"]').ariaSnapshot()).toContain("Queued")
    const open = { ...assistant, finish: undefined }
    await page.evaluate(
      (messages) => window.__deliver({ type: "messagesLoaded", sessionID: "ses_queue", messages }),
      [user, open, next],
    )
    expect(await page.evaluate(() => window.__session.queuedMessages())).toEqual(["msg_1", "msg_3"])
    // Same IDs and empty assistant parts: only authoritative terminal metadata
    // changes. The actual SessionProvider reconcile path must not skip it.
    const failed = { ...open, error: { name: "UnknownError" }, time: { created: 2, completed: 4 } }
    await page.evaluate(
      (messages) => window.__deliver({ type: "messagesLoaded", sessionID: "ses_queue", messages, mode: "reconcile" }),
      [user, failed, next],
    )
    await expect.poll(() => page.evaluate(() => window.__session.queuedMessages())).toEqual(["msg_3"])
    await expect(page.locator('[data-message="msg_1"] [data-slot="user-message-text"][data-queued]')).toHaveCount(0)
    await expect(page.locator('[data-message="msg_3"] [data-slot="user-message-text"][data-queued]')).toHaveCount(1)
    expect(await page.locator('[data-message="msg_1"]').ariaSnapshot()).not.toContain("Queued")
    expect(await page.locator('[data-message="msg_3"]').ariaSnapshot()).toContain("Queued")
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
}, 30000)

test("mounted ordinary chat waits only for the fresh active input and clears on retry, switch and abort", async () => {
  const dir = await compile()
  const browser = await chromium.launch({ headless: true, channel: "msedge" })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (err) => errors.push(err.message))
  try {
    await Bun.write(resolve(dir, "index.html"), '<div id="root"></div>')
    await page.clock.install({ time: new Date("2026-10-27T12:00:00Z") })
    await page.clock.pauseAt(new Date("2026-10-27T12:00:01Z"))
    await page.goto(`${pathToFileURL(resolve(dir, "index.html")).href}?inference`)
    await page.addScriptTag({ path: resolve(dir, "session-queue-mounted.js") })
    const deliver = (message: unknown) => page.evaluate((value) => window.__deliver(value), message)
    const reads = () => page.evaluate(() => window.__sent.filter((value) => value.type === "requestLocalInference"))
    await deliver({ type: "connectionState", state: "connected" })
    await deliver({ type: "sessionCreated", session: { id: "ses_wait", title: "Wait fixture" } })
    await page.evaluate(() => window.__session.setCurrentSessionID("ses_wait"))
    await deliver({
      type: "messagesLoaded",
      sessionID: "ses_wait",
      messages: [
        { id: "msg_active", sessionID: "ses_wait", role: "user", time: { created: 1 }, parts: [] },
        {
          id: "msg_assistant",
          sessionID: "ses_wait",
          role: "assistant",
          parentID: "msg_active",
          time: { created: 2 },
          parts: [],
        },
        { id: "msg_queued", sessionID: "ses_wait", role: "user", time: { created: 3 }, parts: [] },
      ],
    })
    await deliver({ type: "sessionStatus", sessionID: "ses_wait", status: "busy" })
    await expect.poll(async () => (await reads()).length).toBe(1)
    const receipt = async (
      active = 0,
      messageID = "msg_active",
      request?: { sessionID: string; requestID: string },
    ) => {
      const list = await reads()
      const selected = request ?? list.at(-1)
      if (!selected) throw new Error("Missing actual inference request")
      const now = await page.evaluate(() => Date.now())
      await deliver({
        type: "localInferenceLoaded",
        sessionID: selected.sessionID,
        requestID: selected.requestID,
        snapshot: {
          version: 1,
          sessionID: selected.sessionID,
          epoch: "10ff0000-0000-4000-8000-000000000000",
          observedAt: now,
          requests: [{ messageID, queued: 1, active, since: now - 6_000 }],
        },
      })
    }
    const label = page.locator(".working-status-line:not([data-old]) .sr-only")
    const duration = page.locator('[data-slot="chat-local-inference-wait"]')
    await page.clock.fastForward(5_000)
    expect((await reads()).length).toBe(1) // one unanswered read, no overlapping poll
    await receipt()
    await expect(label).toHaveText("Waiting for local model")
    await expect(duration).toHaveText("Model wait: 6s")
    const before = (await reads()).length
    await deliver({ type: "localInferenceChanged", sessionID: "ses_foreign" })
    expect((await reads()).length).toBe(before)
    await deliver({ type: "localInferenceChanged", sessionID: "ses_wait" })
    expect((await reads()).length).toBe(before + 1)
    await expect(duration).toHaveCount(0)
    for (let index = 0; index < 12; index++) await deliver({ type: "localInferenceChanged", sessionID: "ses_wait" })
    expect((await reads()).length).toBe(before + 1)
    await receipt()
    expect((await reads()).length).toBe(before + 2)
    await expect(duration).toHaveCount(0) // an invalidated pending snapshot cannot restore the label
    await receipt()
    await expect(duration).toHaveCount(1)
    await page.clock.fastForward(5_000)
    await receipt(1)
    await expect(duration).toHaveCount(0)
    await expect(label).not.toHaveText("Waiting for local model")
    await page.clock.fastForward(5_000)
    await receipt(0, "msg_queued")
    await expect(duration).toHaveCount(0) // a queued newer user is not the active turn
    await page.clock.fastForward(5_000)
    await receipt()
    await expect(duration).toHaveCount(1)
    await deliver({
      type: "sessionStatus",
      sessionID: "ses_wait",
      status: "retry",
      attempt: 1,
      message: "Retry fixture",
      next: 1793103000000,
    })
    await expect(duration).toHaveCount(0)
    await expect(label).toHaveText("Retry fixture")
    await deliver({ type: "sessionStatus", sessionID: "ses_wait", status: "busy" })
    const stale = (await reads()).at(-1)
    await deliver({ type: "connectionState", state: "disconnected" })
    await expect(duration).toHaveCount(0)
    await deliver({ type: "connectionState", state: "connected" })
    const current = (await reads()).at(-1)
    expect(current?.requestID).not.toBe(stale?.requestID)
    await receipt(0, "msg_active", stale)
    await expect(duration).toHaveCount(0)
    await receipt()
    await expect(duration).toHaveCount(1)
    await deliver({ type: "sessionCreated", session: { id: "ses_other", title: "Other fixture" } })
    await page.evaluate(() => window.__session.setCurrentSessionID("ses_other"))
    await receipt(0, "msg_active", current)
    await expect(duration).toHaveCount(0)
    await page.evaluate(() => window.__session.setCurrentSessionID("ses_wait"))
    await receipt()
    await expect(duration).toHaveCount(1)
    const late = (await reads()).at(-1)
    await page.getByRole("button", { name: "Stop fixture turn" }).click()
    await expect(duration).toHaveCount(0)
    await receipt(0, "msg_active", late)
    const count = (await reads()).length
    await deliver({ type: "localInferenceChanged", sessionID: "ses_wait" })
    await page.clock.fastForward(10_000)
    expect((await reads()).length).toBe(count)
    await expect(duration).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
}, 30000)
