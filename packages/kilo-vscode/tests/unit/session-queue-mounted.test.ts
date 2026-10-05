import { test } from "bun:test"
import { build } from "esbuild"
import { chromium, expect } from "@playwright/test"
import { transformAsync } from "@babel/core"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
const require = createRequire(import.meta.url)

test("mounted terminal parent reconciles stale queue while retaining newer pending prompts", async () => {
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
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
}, 30000)
