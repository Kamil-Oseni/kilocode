import { test } from "bun:test"
import { build } from "esbuild"
import { chromium, expect } from "@playwright/test"
import { transformAsync } from "@babel/core"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
const require = createRequire(import.meta.url)

test("mounted correlated async failure settles only its original submission", async () => {
  const root = resolve(import.meta.dir, "../..")
  const dir = resolve(root, "node_modules/.cache/session-error-mounted")
  const solid = dirname(require.resolve("solid-js/package.json"))
  await build({
    absWorkingDir: root,
    tsconfig: resolve(root, "webview-ui/tsconfig.json"),
    entryPoints: [resolve(root, "tests/fixtures/session-error-mounted.jsx")],
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
    await page.addScriptTag({ path: resolve(dir, "session-error-mounted.js") })
    await page.evaluate(async () => {
      await window.__deliver({ type: "sessionCreated", session: { id: "ses_queue", title: "Queue regression" } })
      window.__session.setCurrentSessionID("ses_queue")
    })
    const send = () =>
      page.evaluate(() => {
        window.__session.sendMessage("Saved original prompt", "test", "local")
        return window.__posts.filter((row) => row.type === "sendMessage").at(-1)
      })
    const fail = (messageID: string, sessionID = "ses_queue", eventID = crypto.randomUUID()) =>
      page.evaluate((message) => window.__deliver(message), {
        type: "sessionError",
        eventID,
        messageID,
        sessionID,
        error: { name: "UnknownError", data: { message: "Synthetic pre-intake failure" } },
      })
    await page.evaluate(() => window.__deliver({ type: "connectionState", state: "connected" }))
    const first = await send()
    expect(first?.messageID).toBeTruthy()
    expect(await page.evaluate(() => window.__session.submitting())).toBe(true)
    await fail(first.messageID, "other")
    expect(await page.evaluate(() => window.__session.submitting())).toBe(true)
    await fail(first.messageID)
    await expect.poll(() => page.evaluate(() => window.__session.submitting())).toBe(false)
    expect(await page.evaluate(() => window.__session.status())).toBe("idle")
    expect(await page.evaluate(() => window.__session.busySince())).toBeUndefined()
    const next = await send()
    await fail(first.messageID)
    expect(await page.evaluate(() => window.__session.submitting())).toBe(true)
    await fail(next.messageID, "other")
    expect(await page.evaluate(() => window.__session.submitting())).toBe(true)
    const concurrent = await send()
    await fail(next.messageID)
    expect(await page.evaluate(() => window.__session.submitting())).toBe(true)
    await page.evaluate(
      (messageID) =>
        window.__deliver({
          type: "sessionError",
          eventID: "evt-unscoped",
          messageID,
          error: { name: "UnknownError", data: { message: "Unscoped error cannot settle a submission" } },
        }),
      concurrent.messageID,
    )
    expect(await page.evaluate(() => window.__session.submitting())).toBe(true)
    await fail(concurrent.messageID)
    await expect.poll(() => page.evaluate(() => window.__session.submitting())).toBe(false)
    // An accepted canonical user message must survive a later execution failure.
    const accepted = await send()
    await page.evaluate((message) => window.__deliver({ type: "messageCreated", message }), {
      id: accepted.messageID,
      sessionID: "ses_queue",
      role: "user",
      createdAt: new Date().toISOString(),
      parts: [
        {
          id: "prt_accepted",
          type: "text",
          messageID: accepted.messageID,
          sessionID: "ses_queue",
          text: "Saved original prompt",
        },
      ],
    })
    await fail(accepted.messageID)
    await expect.poll(() => page.evaluate(() => window.__session.submitting())).toBe(false)
    expect(
      await page.evaluate((id) => window.__session.messages().some((row) => row.id === id), accepted.messageID),
    ).toBe(true)
    expect(await page.evaluate(() => window.__posts.filter((row) => row.type === "sendMessage").length)).toBe(4)
    expect(await page.evaluate(() => window.__posts.filter((row) => row.type === "composerDraftClear").length)).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
}, 30000)
