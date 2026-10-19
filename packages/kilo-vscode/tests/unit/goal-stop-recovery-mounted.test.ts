import { test } from "bun:test"
import { build } from "esbuild"
import { chromium, expect } from "@playwright/test"
import { transformAsync } from "@babel/core"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)

test("mounted cleared Stop recovery sends only the reviewed original intent after an explicit click", async () => {
  const root = resolve(import.meta.dir, "../..")
  const dir = resolve(root, "node_modules/.cache/goal-stop-recovery-mounted")
  const solid = dirname(require.resolve("solid-js/package.json"))
  await build({
    absWorkingDir: root,
    tsconfig: resolve(root, "webview-ui/tsconfig.json"),
    entryPoints: [resolve(root, "tests/fixtures/goal-stop-recovery-mounted.jsx")],
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
    await page.addScriptTag({ path: resolve(dir, "goal-stop-recovery-mounted.js") })
    await page.evaluate(async () => {
      await window.__deliver({ type: "sessionCreated", session: { id: "ses_stop", title: "Stop recovery" } })
      window.__session.setCurrentSessionID("ses_stop")
      await window.__deliver({ type: "connectionState", state: "connected" })
      await window.__deliver({ type: "goalState", sessionID: "ses_stop" })
    })
    const stop = { intent: "saved-original-stop", at: 1, phase: "cleared", interrupted: false, retirement: true }
    const deliver = (value: unknown, sessionID = "ses_stop") =>
      page.evaluate((message) => window.__deliver(message), {
        type: "goalStopResult",
        sessionID,
        notice: "Stop finalization pending. Tracking removal and the cancellation result were saved.",
        stop: value,
      })
    const retry = page.getByRole("button", { name: "Retry stop finalization", exact: true })
    const posts = () => page.evaluate(() => window.__posts.filter((row) => row.type === "goalStop"))
    for (const value of [
      undefined,
      { ...stop, intent: "" },
      { ...stop, at: Number.NaN },
      { ...stop, phase: "requested" },
      { ...stop, interrupted: undefined },
      { ...stop, retirement: undefined },
      { ...stop, phase: "finished" },
    ]) {
      await deliver(value)
      await expect(retry).toHaveCount(0)
    }
    await deliver(stop, "other-session")
    await expect(retry).toHaveCount(0)
    await deliver(stop)
    await expect(retry).toBeVisible()
    expect(await posts()).toHaveLength(0)
    await page.evaluate(() =>
      window.__deliver({
        type: "goalState",
        sessionID: "ses_stop",
        goal: {
          objective: "A newer goal",
          intent: "newer-intent",
          status: "paused",
          createdAt: 2,
          updatedAt: 2,
          progress: [],
          usage: { turns: 0, continuations: 0, toolCalls: 0 },
        },
      }),
    )
    await deliver(stop)
    await expect(retry).toHaveCount(0)
    await page.evaluate(() => window.__deliver({ type: "goalState", sessionID: "ses_stop" }))
    await deliver(stop)
    await expect(retry).toBeVisible()
    await page.evaluate(async () => {
      await window.__deliver({ type: "connectionState", state: "disconnected" })
      await window.__deliver({ type: "connectionState", state: "connected" })
    })
    await expect(retry).toHaveCount(0)
    expect(await posts()).toHaveLength(0)
    await deliver(stop)
    await expect(retry).toBeVisible()
    await page.evaluate(async () => {
      await window.__deliver({ type: "sessionCreated", session: { id: "ses_other", title: "Another session" } })
      window.__session.setCurrentSessionID("ses_other")
    })
    await deliver(stop)
    await expect(retry).toHaveCount(0)
    await page.evaluate(() => window.__session.setCurrentSessionID("ses_stop"))
    await expect(retry).toHaveCount(0)
    await page.evaluate(() => window.__deliver({ type: "goalState", sessionID: "ses_stop" }))
    await deliver(stop)
    await expect(retry).toBeVisible()
    // Dispatch two real DOM clicks in one turn; the connected component must fence the second.
    await retry.evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    const sent = await posts()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ sessionID: "ses_stop", expectedIntent: stop.intent, retry: true })
    expect(sent[0].requestID).toBeTruthy()
    await page.evaluate(
      (requestID) =>
        window.__deliver({
          type: "goalStopped",
          sessionID: "ses_stop",
          requestID,
          error: "The connection failed before finalization was confirmed. Refresh the saved result.",
        }),
      sent[0].requestID,
    )
    await expect(retry).toHaveCount(0)
    const refresh = page.getByRole("button", { name: "Refresh stop result", exact: true })
    await expect(refresh).toBeVisible()
    await page.evaluate(() => window.__deliver({ type: "connectionState", state: "connected" }))
    await deliver(stop)
    expect(await posts()).toHaveLength(1)
    await expect(retry).toHaveCount(0)
    const count = await page.evaluate(() => window.__posts.filter((row) => row.type === "goalGet").length)
    await refresh.click()
    expect(await page.evaluate(() => window.__posts.filter((row) => row.type === "goalGet").length)).toBe(count + 1)
    expect(await posts()).toHaveLength(1)
    await deliver({ ...stop, phase: "finished" })
    await expect(retry).toHaveCount(0)
    expect(await posts()).toHaveLength(1)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
}, 30_000)
