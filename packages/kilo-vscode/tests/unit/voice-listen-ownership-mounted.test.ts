import { test } from "bun:test"
import { build } from "esbuild"
import { chromium, expect } from "@playwright/test"
import { transformAsync } from "@babel/core"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
const require = createRequire(import.meta.url)

async function mounted() {
  const root = resolve(import.meta.dir, "../..")
  const dir = resolve(root, "node_modules/.cache/voice-listen-ownership-mounted")
  const solid = dirname(require.resolve("solid-js/package.json"))
  await build({
    absWorkingDir: root,
    tsconfig: resolve(root, "webview-ui/tsconfig.json"),
    entryPoints: [resolve(root, "tests/fixtures/voice-session-mounted.jsx")],
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
  const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => {
    if (errors.length < 16) errors.push(error.name)
  })
  try {
    await Bun.write(resolve(dir, "index.html"), '<div id="root"></div>')
    await page.goto(pathToFileURL(resolve(dir, "index.html")).href)
    await page.addScriptTag({ path: resolve(dir, "voice-session-mounted.js") })
    await page.getByRole("button", { name: "Start hands-free voice", exact: true }).waitFor()
    await page.evaluate(() => {
      window.__session.setCurrentSessionID("ses_a")
      window.__session.selectAgent("code")
      window.__session.selectModel("kilo", "synthetic-pinned-4b")
    })
    await page.evaluate(() => window.__deliver({ type: "sessionStatus", sessionID: "ses_a", status: "busy" }))
    await expect.poll(() => page.evaluate(() => window.__session.status())).toBe("busy")
    // Real voice activation establishes the cascade lifetime; a mode flag alone is insufficient.
    await page.evaluate(() => window.__voice.start("ses_a"))
    await page.evaluate(() =>
      window.__deliver({
        type: "speechRealtimeError",
        code: "configuration",
        error: "Synthetic cascade admission",
        fallback: "cascade-v1",
      }),
    )
    await expect.poll(() => page.evaluate(() => window.__voice.cascade())).toBe(true)
    await expect.poll(() => page.evaluate(() => window.__voice.status())).toBe("connecting")
    expect(await page.evaluate(() => window.__media)).toBe(0)
    expect(await page.evaluate(() => window.__messages.filter((row) => row.type === "speechToTextStart").length)).toBe(
      0,
    )
    return { page, browser, errors }
  } catch (err) {
    await browser.close()
    throw err
  }
}

test.each(["idle", "session", "scope", "cancel", "mode", "composer"])(
  "mounted busy hands-free retry retains original ownership across %s",
  async (kind) => {
    const { page, browser, errors } = await mounted()
    try {
      // Repeated events while busy must share one original retry rather than mint more work.
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("rayaVoiceListen"))
        window.dispatchEvent(new CustomEvent("rayaVoiceListen"))
      })
      if (kind === "session") {
        await page.evaluate(() => window.__session.setCurrentSessionID("ses_b"))
        await expect.poll(() => page.evaluate(() => window.__session.currentSessionID())).toBe("ses_b")
        await page.evaluate(() => window.__session.setCurrentSessionID("ses_a"))
        await expect.poll(() => page.evaluate(() => window.__session.currentSessionID())).toBe("ses_a")
      }
      if (kind === "scope") {
        // Unlike a session switch, this ABA keeps the same active VoiceProvider lifetime.
        await page.evaluate(() => window.__box("voice-temporary"))
        await page.waitForTimeout(0)
        await page.evaluate(() => window.__box("voice-mounted"))
        await page.waitForTimeout(0)
        expect(await page.evaluate(() => window.__voice.cascade())).toBe(true)
        expect(await page.evaluate(() => window.__voice.status())).toBe("connecting")
      }
      if (kind === "cancel") await page.evaluate(() => window.dispatchEvent(new CustomEvent("rayaVoiceCancel")))
      if (kind === "mode") {
        await page.evaluate(() => window.__voice.setMode("off"))
        await expect.poll(() => page.evaluate(() => window.__voice.settings().mode)).toBe("off")
        await page.evaluate(() => window.__voice.setMode("hands-free"))
      }
      if (kind === "composer") {
        // Keep the genuine VoiceProvider alive and eligible while replacing only PromptInput.
        // A stale global timer would target this new composer.
        await page.evaluate(() => window.__composer(false))
        await expect(page.locator("textarea.prompt-input")).toHaveCount(0)
        await page.evaluate(() => window.__composer(true))
        await expect(page.locator("textarea.prompt-input")).toHaveCount(1)
      }
      await page.evaluate(() => window.__deliver({ type: "sessionStatus", sessionID: "ses_a", status: "idle" }))
      await expect.poll(() => page.evaluate(() => window.__session.status())).toBe("idle")
      if (kind === "idle") {
        await expect.poll(() => page.evaluate(() => window.__media)).toBe(1)
        await expect
          .poll(() => page.evaluate(() => window.__messages.filter((row) => row.type === "speechToTextStart").length))
          .toBe(1)
      }
      // Actual timer duration, no fake clock: allow several retries to expose old queued callbacks.
      await page.waitForTimeout(350)
      expect(await page.evaluate(() => window.__media)).toBe(kind === "idle" ? 1 : 0)
      expect(
        await page.evaluate(() => window.__messages.filter((row) => row.type === "speechToTextStart").length),
      ).toBe(kind === "idle" ? 1 : 0)
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  },
  60_000,
)
