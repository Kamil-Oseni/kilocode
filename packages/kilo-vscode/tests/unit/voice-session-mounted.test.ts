import { test } from "bun:test"
import { build } from "esbuild"
import { chromium, expect } from "@playwright/test"
import { transformAsync } from "@babel/core"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
const require = createRequire(import.meta.url)

test.each([false, true, "owned"])(
  "mounted Voice preserves pending and newer drafts with reversed subscribers %s",
  async (reverse) => {
    const root = resolve(import.meta.dir, "../..")
    const dir = resolve(root, "node_modules/.cache/voice-session-mounted")
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
    const rows: Array<Record<string, unknown>> = []
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
    page.on("console", async (event) => {
      if (!event.text().startsWith("[Raya Voice playback]")) return
      const value = event.args()[1]
      if (value) rows.push(await value.jsonValue())
    })
    try {
      await using storage =
        reverse === "owned" ? await (await import("../fixtures/durable-draft-storage")).draftStorage() : undefined
      if (storage)
        await page.exposeFunction("__host", async (message) => {
          if (message.type === "composerDraftPane") {
            if (message.active)
              await page.evaluate(
                (epoch) =>
                  window.__deliver({
                    type: "composerDraftState",
                    epoch,
                    generation: 1,
                    connected: true,
                    owners: [{ box: "voice-mounted", owner: "synthetic-owned-workspace" }],
                  }),
                message.epoch,
              )
            return
          }
          if (
            ![
              "composerDraftLoad",
              "composerDraftSave",
              "composerDraftClear",
              "composerDraftPromote",
              "composerDraftList",
            ].includes(message.type)
          )
            return
          const reply = await storage.handle(message)
          await page.evaluate((reply) => window.__deliver(reply), reply)
        })
      await Bun.write(resolve(dir, "index.html"), '<div id="root"></div>')
      await page.goto(pathToFileURL(resolve(dir, "index.html")).href)
      await page.addScriptTag({ path: resolve(dir, "voice-session-mounted.js") })
      await page.evaluate((value) => {
        window.__reverse = value === true
      }, reverse)
      expect(errors).toEqual([])
      const start = page.getByRole("button", { name: "Start hands-free voice", exact: true })
      await start.waitFor()
      await expect.poll(() => page.evaluate(() => window.__session.currentSessionID())).toBeUndefined()
      await page.evaluate(() => {
        window.__session.selectAgent("code")
        window.__session.selectModel("kilo", "synthetic-pinned-4b")
      })
      await start.click()
      expect(
        await page.evaluate(() => window.__messages.find((entry) => entry.type === "fixtureAudioResume").activated),
      ).toBe(true)
      await expect.poll(() => page.evaluate(() => window.__contexts[0].state)).toBe("running")
      expect(
        await page.evaluate(() => {
          const resume = window.__messages.findIndex((entry) => entry.type === "fixtureAudioResume")
          const create = window.__messages.findIndex((entry) => entry.type === "createSession")
          return resume < create
        }),
      ).toBe(true)
      const cancel = page.getByRole("button", { name: "Cancel voice startup", exact: true })
      await expect(cancel).toBeEnabled()
      await expect(cancel.locator("svg rect")).toHaveCount(1)
      await page.locator("textarea.prompt-input").fill("  typed during voice startup\nretain this exact draft  ")
      const draft = await page.evaluate(
        () => window.__messages.findLast((entry) => entry.type === "createSession").draftID,
      )
      expect(typeof draft).toBe("string")
      await page.evaluate(() =>
        window.__deliver({ type: "sessionCreated", session: { id: "ses_unrelated", title: "SSE" } }),
      )
      await expect(cancel).toBeVisible()
      await expect.poll(() => page.evaluate(() => window.__session.currentSessionID())).toBeUndefined()
      await page.evaluate(
        (draftID) =>
          window.__deliver({ type: "sessionCreated", draftID, session: { id: "ses_voice", title: "Voice" } }),
        draft,
      )
      await expect.poll(() => page.evaluate(() => window.__session.currentSessionID())).toBe("ses_voice")
      await expect(page.locator("textarea.prompt-input")).toHaveValue(
        "  typed during voice startup\nretain this exact draft  ",
      )
      await expect
        .poll(() =>
          page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechRealtimeStart").length),
        )
        .toBe(1)
      expect(await page.evaluate(() => window.__session.selected("ses_voice"))).toEqual({
        providerID: "kilo",
        modelID: "synthetic-pinned-4b",
      })
      expect(await page.evaluate(() => window.__session.selectedAgent("ses_voice"))).toBe("voice")
      await page.evaluate(() => window.__voice.wait("ses_voice"))
      const previous = await page.evaluate(() =>
        window.__messages.findLast((entry) => entry.type === "speechVoiceTurn"),
      )
      await page.evaluate(() => window.__voice.wait("ses_voice"))
      const playback = await page.evaluate(() =>
        window.__messages.findLast((entry) => entry.type === "speechVoiceTurn"),
      )
      expect(playback.sessionID).toBe("ses_voice")
      expect(playback.requestId).toMatch(/^[a-f0-9-]{36}$/)
      await page.evaluate(() =>
        window.__deliver({ type: "speechPlaybackError", requestId: "unrelated", error: "foreign failure" }),
      )
      expect(await page.evaluate(() => window.__voice.error())).toBeUndefined()
      await page.evaluate(
        (requestId) => window.__deliver({ type: "speechPlaybackError", requestId, error: "stale failure" }),
        previous.requestId,
      )
      await page.evaluate(
        (requestId) =>
          window.__deliver({ type: "speechPlaybackChunk", requestId, data: "AAA=", mime: "audio/pcm;rate=16000" }),
        previous.requestId,
      )
      expect(await page.evaluate(() => window.__voice.error())).toBeUndefined()
      expect(await page.evaluate(() => window.__voice.playing())).toBe(false)
      await expect
        .poll(() => rows.some((row) => row.event === "chunk-stale" && row.request === previous.requestId))
        .toBe(true)
      await page.evaluate(
        (requestId) =>
          window.__deliver({ type: "speechPlaybackChunk", requestId, data: "ACAA4A==", mime: "audio/pcm;rate=24000" }),
        playback.requestId,
      )
      await expect
        .poll(() => rows.some((row) => row.event === "chunk-received" && row.request === playback.requestId))
        .toBe(true)
      await page.evaluate(
        (requestId) =>
          window.__deliver({ type: "speechPlaybackError", requestId, error: "Synthetic prechunk TTS failure" }),
        playback.requestId,
      )
      expect(await page.evaluate(() => window.__voice.error())).toBe("Synthetic prechunk TTS failure")
      expect(await page.evaluate(() => window.__voice.status())).toBe("degraded")
      await page.evaluate(
        (requestId) =>
          window.__deliver({ type: "speechPlaybackChunk", requestId, data: "AAA=", mime: "audio/pcm;rate=16000" }),
        playback.requestId,
      )
      expect(await page.evaluate(() => window.__voice.playing())).toBe(false)
      await expect
        .poll(() => rows.some((row) => row.event === "chunk-paused" && row.request === playback.requestId))
        .toBe(true)
      expect(
        rows
          .filter((row) => String(row.event).startsWith("chunk-"))
          .every((row) => Object.keys(row).every((key) => ["event", "request"].includes(key))),
      ).toBe(true)
      const order = await page.evaluate(() =>
        window.__messages.map((entry) =>
          entry.type === "loadMessages" && entry.mode === "focus" ? `focus:${entry.sessionID}` : entry.type,
        ),
      )
      expect(order.filter((entry) => entry === "focus:ses_voice")).toHaveLength(1)
      expect(order.indexOf("focus:ses_voice")).toBeLessThan(order.indexOf("speechRealtimeStart"))
      await page.locator("textarea.prompt-input").fill("newer session draft after successful voice start")
      await page.evaluate(
        (draftID) =>
          window.__deliver({
            type: "sessionCreated",
            draftID,
            session: { id: "ses_voice", title: "matching duplicate" },
          }),
        draft,
      )
      await page.evaluate(
        (draftID) =>
          window.__deliver({ type: "sessionCreated", draftID, session: { id: "ses_duplicate", title: "duplicate" } }),
        draft,
      )
      await page.evaluate(() =>
        window.__deliver({ type: "sessionCreated", session: { id: "ses_voice", title: "SSE duplicate" } }),
      )
      await expect.poll(() => page.evaluate(() => window.__session.currentSessionID())).toBe("ses_voice")
      await expect(page.locator("textarea.prompt-input")).toHaveValue(
        "newer session draft after successful voice start",
      )
      expect(await page.evaluate(() => window.__messages.filter((entry) => entry.type === "sendMessage"))).toEqual([])
      if (storage) {
        await page.locator("textarea.prompt-input").fill("")
        await page.evaluate(async () => {
          window.__voice.setMode("hands-free")
          await window.__deliver({
            type: "speechRealtimeError",
            code: "configuration",
            error: "Synthetic cascade admission",
            fallback: "cascade-v1",
          })
        })
        await expect
          .poll(() =>
            page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length),
          )
          .toBe(1)
        const request = await page.evaluate(
          () => window.__messages.findLast((entry) => entry.type === "speechToTextStart").requestId,
        )
        await page.evaluate((requestId) => window.__deliver({ type: "speechToTextStarted", requestId }), request)
        await page.evaluate((requestId) => window.__deliver({ type: "speechToTextSilence", requestId }), request)
        await expect
          .poll(() =>
            page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStop").length),
          )
          .toBe(1)
        await page.evaluate(
          (requestId) =>
            window.__deliver({ type: "speechToTextResult", requestId, text: "Can you hear this owned transcript?" }),
          request,
        )
      } else
        await page.evaluate(() => {
          const selected = window.__session.selected("ses_voice")
          window.__session.sendMessage("explicit transport test", selected.providerID, selected.modelID)
        })
      await expect
        .poll(() => page.evaluate(() => window.__messages.filter((entry) => entry.type === "sendMessage").length))
        .toBe(1)
      expect(
        await page.evaluate(() => {
          const message = window.__messages.findLast((entry) => entry.type === "sendMessage")
          return {
            sessionID: message.sessionID,
            agent: message.agent,
            providerID: message.providerID,
            modelID: message.modelID,
          }
        }),
      ).toEqual({ sessionID: "ses_voice", agent: "voice", providerID: "kilo", modelID: "synthetic-pinned-4b" })
      if (storage) {
        const message = await page.evaluate(() => window.__messages.findLast((entry) => entry.type === "sendMessage"))
        expect(message.text).toBe("Can you hear this owned transcript?")
        expect(message.capture.owner).toBe("synthetic-owned-workspace")
        expect(message.capture.identity.sessionID).toBe("ses_voice")
        const saved = await storage.handle({
          type: "composerDraftLoad",
          ...message.capture,
          requestID: crypto.randomUUID(),
        })
        expect(saved.entry?.content?.model).toEqual({ providerID: "kilo", modelID: "synthetic-pinned-4b" })
        expect(saved.entry?.content?.text).toBe(message.text)
      }
      const stops = await page.evaluate(
        () => window.__messages.filter((entry) => entry.type === "speechRealtimeStop").length,
      )
      await page.getByRole("button", { name: "Stop hands-free listening", exact: true }).click()
      await expect(cancel).toHaveCount(0)
      await expect(page.getByRole("button", { name: /End voice/ })).toHaveCount(0)
      expect(
        await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechRealtimeStop").length),
      ).toBeGreaterThan(stops)
      await page.evaluate(() => window.__voice.start("ses_voice"))
      await page.evaluate(
        (requestId) => window.__deliver({ type: "speechPlaybackError", requestId, error: "old generation failure" }),
        playback.requestId,
      )
      await page.evaluate(
        (requestId) =>
          window.__deliver({ type: "speechPlaybackChunk", requestId, data: "AAA=", mime: "audio/pcm;rate=16000" }),
        playback.requestId,
      )
      expect(await page.evaluate(() => window.__voice.error())).toBeUndefined()
      expect(await page.evaluate(() => window.__voice.playing())).toBe(false)
      await page.evaluate(() => window.__voice.stop())
      await page.locator("textarea.prompt-input").fill("")
      await page.evaluate(() => window.__session.clearCurrentSession())
      await expect(start).toBeVisible()
      const creations = await page.evaluate(
        () => window.__messages.filter((entry) => entry.type === "createSession").length,
      )
      await page.evaluate(() => {
        window.__preparation = true
      })
      await start.click()
      await expect(cancel).toHaveCount(0)
      expect(await page.evaluate(() => window.__voice.error())).toBe("Synthetic AudioContext preparation failure")
      expect(
        await page.evaluate(() => window.__messages.filter((entry) => entry.type === "createSession").length),
      ).toBe(creations)
      await page.evaluate(() => {
        window.__preparation = false
        window.__voice.stop()
      })
      for (const kind of ["cancel", "cleanup", "navigate", "cloud", "disconnect", "failure", "unmount"]) {
        if (kind === "cancel")
          await page.evaluate(() => {
            window.__bridgeHold = true
          })
        await start.click()
        if (kind === "cleanup") {
          await page.evaluate(async () => {
            const current = window.__peers.slice(-2)
            window.__bridgeReject(new Error("Original canceled bridge offer failed late"))
            await new Promise((resolve) => setTimeout(resolve, 0))
            if (current.some((peer) => peer.connectionState === "closed"))
              throw new Error("Old bridge closed replacement")
          })
        }
        const closes = await page.evaluate(
          () => window.__messages.filter((entry) => entry.type === "fixtureAudioClose").length,
        )
        const request = await page.evaluate(
          () => window.__messages.findLast((entry) => entry.type === "createSession").draftID,
        )
        if (kind === "cancel" || kind === "failure")
          await page.locator("textarea.prompt-input").fill("newer typed draft")
        if (kind === "cancel") {
          await cancel.click()
          await page.evaluate(() => {
            window.__bridgeHold = false
          })
        }
        if (kind === "cleanup") {
          await page.evaluate(() => {
            window.__cleanup = true
          })
          await cancel.click()
          expect(await page.evaluate(() => window.__voice.error())).toBe("Synthetic AudioContext cleanup failure")
          await page.evaluate(() => {
            window.__cleanup = false
            window.__voice.stop()
          })
        }
        if (kind === "navigate") await page.evaluate(() => window.__session.selectSession("ses_existing"))
        if (kind === "cloud") await page.evaluate(() => window.__session.selectCloudSession("cloud-existing"))
        if (kind === "disconnect")
          await page.evaluate(() => window.__deliver({ type: "connectionState", state: "disconnected" }))
        if (kind === "failure")
          await page.evaluate(
            (draftID) => window.__deliver({ type: "sendMessageFailed", draftID, text: "", error: "creation failed" }),
            request,
          )
        if (kind === "unmount") await page.evaluate(() => window.__unmount())
        await expect(cancel).toHaveCount(0)
        await expect
          .poll(() =>
            page.evaluate(() => window.__messages.filter((entry) => entry.type === "fixtureAudioClose").length),
          )
          .toBeGreaterThan(closes)
        if (kind === "cancel" || kind === "failure")
          await expect(page.locator("textarea.prompt-input")).toHaveValue("newer typed draft")
        await page.evaluate(
          (draftID) =>
            window.__deliver({ type: "sessionCreated", draftID, session: { id: "ses_late", title: "late" } }),
          request,
        )
        await expect
          .poll(() =>
            page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechRealtimeStart").length),
          )
          .toBe(2)
        expect(await page.evaluate(() => window.__session.currentSessionID())).not.toBe("ses_late")
        if (kind === "cancel" || kind === "failure") {
          await expect(page.locator("textarea.prompt-input")).toHaveValue("newer typed draft")
          await page.locator("textarea.prompt-input").fill("")
        }
        if (kind !== "unmount") {
          await page.evaluate(async () => {
            window.__session.clearCurrentSession()
            await window.__deliver({ type: "connectionState", state: "connected" })
          })
          await start.waitFor()
        }
      }
      expect(await page.evaluate(() => window.__media)).toBe(storage ? 1 : 0)
      expect(
        await page.evaluate(() =>
          window.__messages.filter(
            (entry) =>
              entry.type === "loadMessages" &&
              entry.mode === "focus" &&
              ["ses_late", "ses_duplicate"].includes(entry.sessionID),
          ),
        ),
      ).toEqual([])
      expect(errors).toEqual([])
    } catch (error) {
      console.log({
        errors,
        messages: await page.evaluate(() => window.__messages),
        body: await page.locator("body").innerText(),
      })
      throw error
    } finally {
      await browser.close()
    }
  },
  120_000,
)
