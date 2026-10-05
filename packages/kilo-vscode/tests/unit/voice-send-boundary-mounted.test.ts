import { test } from "bun:test"
import { build } from "esbuild"
import { chromium, expect } from "@playwright/test"
import { transformAsync } from "@babel/core"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
const require = createRequire(import.meta.url)

import { VoiceReplies } from "../../src/speech/replies"

test("actual Voice composer arms replies only at dispatch and ignores retired VAD", async () => {
  const root = resolve(import.meta.dir, "../..")
  const dir = resolve(root, "node_modules/.cache/voice-send-boundary-mounted")
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
  const browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--mute-audio"] })
  const page = await browser.newPage()
  const errors: string[] = []

  const replies = new VoiceReplies()
  const captured: Array<{ request?: string; message: Record<string, unknown> }> = []
  try {
    await using storage = await (await import("../fixtures/durable-draft-storage")).draftStorage()
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
        [
          "composerDraftLoad",
          "composerDraftSave",
          "composerDraftClear",
          "composerDraftPromote",
          "composerDraftList",
        ].includes(message.type)
      ) {
        const reply = await storage.handle(message)
        await page.evaluate((reply) => window.__deliver(reply), reply)
        return
      }
      if (message.type === "speechVoiceTurn") replies.mark(message)
      if (message.type === "speechPlaybackCancel") replies.cancel(message.requestId)
      if (message.type === "sendMessage") {
        const request = replies.capture(message.sessionID)
        captured.push({ request, message })
        if (request) {
          expect(replies.bind(message.sessionID, message.messageID, request)).toBe(true)
          replies.message(message.sessionID, "assistant", `assistant-${message.messageID}`, message.messageID, true)
          replies.part(message.sessionID, {
            id: `part-${message.messageID}`,
            messageID: `assistant-${message.messageID}`,
            type: "text",
            text: "Synthetic reply",
            time: { start: 1, end: 2 },
          })
          expect(replies.complete(message.sessionID)?.requestId).toBe(request)
        }
        const receipt = await storage.handle({
          type: "composerDraftClear",
          requestID: crypto.randomUUID(),
          epoch: message.capture.epoch,
          generation: message.capture.generation,
          owner: message.capture.owner,
          identity: message.capture.identity,
          expected: message.capture.token,
          mutation: crypto.randomUUID(),
        })
        console.log("Synthetic SQL receipt", {
          error: receipt.error,
          entry: !!receipt.entry,
          token: !!message.capture.token,
        })
        expect(receipt.error).toBeUndefined()
        await page.evaluate((value) => window.__deliver(value), {
          type: "composerDraftAccepted",
          epoch: message.capture.epoch,
          generation: message.capture.generation,
          sessionID: message.sessionID,
          messageID: message.messageID,
          capture: message.capture,
          entry: receipt.entry,
        })
      }
    })
    await Bun.write(resolve(dir, "index.html"), '<div id="root"></div>')
    await page.goto(pathToFileURL(resolve(dir, "index.html")).href)
    await page.addScriptTag({ path: resolve(dir, "voice-session-mounted.js") })
    const input = page.locator("textarea.prompt-input")
    await page.getByRole("button", { name: "Start hands-free voice", exact: true }).waitFor()
    await page.evaluate(() => {
      window.__session.selectAgent("code")
      window.__session.selectModel("kilo", "synthetic-pinned-4b")
    })
    await page.getByRole("button", { name: "Start hands-free voice", exact: true }).click()
    await input.fill("Synthetic pending draft")
    const draft = await page.evaluate(
      () => window.__messages.findLast((entry) => entry.type === "createSession").draftID,
    )
    await page.evaluate(
      (draftID) => window.__deliver({ type: "sessionCreated", draftID, session: { id: "ses_voice", title: "Voice" } }),
      draft,
    )
    await expect.poll(() => page.evaluate(() => window.__session.currentSessionID())).toBe("ses_voice")
    await expect(input).toHaveValue("Synthetic pending draft")
    await input.fill("")
    await expect
      .poll(() => page.evaluate(() => window.__messages.filter((entry) => entry.type === "composerDraftSave").length))
      .toBeGreaterThan(0)
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
      .poll(() => page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length))
      .toBe(1)
    const request = await page.evaluate(
      () => window.__messages.findLast((entry) => entry.type === "speechToTextStart").requestId,
    )
    await page.evaluate(async (requestId) => {
      await window.__deliver({ type: "speechToTextStarted", requestId })
      await window.__deliver({ type: "speechToTextSpeech", requestId })
    }, request)
    const cancels = await page.evaluate(
      () => window.__messages.filter((entry) => entry.type === "speechPlaybackCancel").length,
    )
    await page.evaluate(async (requestId) => {
      await window.__deliver({ type: "speechToTextSilence", requestId })
      await window.__deliver({ type: "speechToTextSpeech", requestId })
      await window.__deliver({ type: "speechToTextSilence", requestId })
    }, request)
    expect(
      await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechPlaybackCancel").length),
    ).toBe(cancels)
    expect(
      await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStop").length),
    ).toBe(1)
    expect(
      await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechVoiceTurn").length),
    ).toBe(0)
    await page.evaluate(
      (requestId) => window.__deliver({ type: "speechToTextResult", requestId, text: "Synthetic owned spoken prompt" }),
      request,
    )
    await expect.poll(() => captured.length).toBe(1)
    await expect(input).toHaveValue("")
    expect(captured[0].request).toMatch(/^[a-f0-9-]{36}$/)
    expect(captured[0].message).toMatchObject({
      agent: "voice",
      modelID: "synthetic-pinned-4b",
      text: "Synthetic owned spoken prompt",
    })
    expect(
      await page.evaluate(() => {
        const rows = window.__messages.map((entry) => entry.type)
        return rows.lastIndexOf("speechVoiceTurn") < rows.lastIndexOf("sendMessage")
      }),
    ).toBe(true)
    // Real recording VAD still retires the actual outstanding reply; empty transcription does not.
    await page.evaluate(async () => {
      await window.__deliver({ type: "sessionStatus", sessionID: "ses_voice", status: "idle" })
      window.dispatchEvent(new CustomEvent("rayaVoiceListen"))
    })
    await expect
      .poll(() => page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length))
      .toBe(2)
    const empty = await page.evaluate(
      () => window.__messages.findLast((entry) => entry.type === "speechToTextStart").requestId,
    )
    await page.evaluate(async (requestId) => {
      await window.__deliver({ type: "speechToTextStarted", requestId })
      await window.__deliver({ type: "speechToTextSilence", requestId })
    }, empty)
    const retained = replies.request()
    await page.evaluate((requestId) => window.__deliver({ type: "speechToTextResult", requestId, text: "  " }), empty)
    await expect
      .poll(() => page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length))
      .toBe(3)
    expect(replies.request()).toBe(retained)
    expect(await page.evaluate(() => window.__voice.status())).not.toBe("degraded")
    expect(captured).toHaveLength(1)
    await page.evaluate((requestId) => window.__deliver({ type: "speechToTextResult", requestId, text: "" }), empty)
    expect(
      await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length),
    ).toBe(3)
    const vacant = await page.evaluate(
      () => window.__messages.findLast((entry) => entry.type === "speechToTextStart").requestId,
    )
    await page.evaluate(async (requestId) => {
      await window.__deliver({ type: "speechToTextStarted", requestId })
      await window.__deliver({ type: "speechToTextSilence", requestId })
      await window.__deliver({
        type: "speechToTextError",
        requestId,
        code: "empty_transcript",
        error: "Synthetic no speech",
      })
    }, vacant)
    await expect
      .poll(() => page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length))
      .toBe(4)
    expect(replies.request()).toBe(retained)
    expect(captured).toHaveLength(1)
    await page.evaluate(() =>
      window.__deliver({
        type: "speechToTextCancelled",
        requestId: window.__messages.findLast((entry) => entry.type === "speechToTextStart").requestId,
      }),
    )
    await input.fill("Typed Voice prompt")
    await input.press("Enter")
    await expect.poll(() => captured.length).toBe(2)
    expect(captured[1].request).toMatch(/^[a-f0-9-]{36}$/)
    expect(captured[1].request).not.toBe(captured[0].request)
    expect(captured[1].message).toMatchObject({
      agent: "voice",
      modelID: "synthetic-pinned-4b",
      text: "Typed Voice prompt",
    })
    await page.evaluate(async () => {
      await window.__deliver({ type: "sessionStatus", sessionID: "ses_voice", status: "idle" })
      window.dispatchEvent(new CustomEvent("rayaVoiceListen"))
    })
    await expect
      .poll(() => page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length))
      .toBe(5)
    const active = await page.evaluate(
      () => window.__messages.findLast((entry) => entry.type === "speechToTextStart").requestId,
    )
    await page.evaluate((requestId) => window.__deliver({ type: "speechToTextStarted", requestId }), active)
    await page.evaluate((requestId) => window.__deliver({ type: "speechToTextSpeech", requestId }), active)
    await expect.poll(() => replies.request()).toBeUndefined()
    await page.evaluate(
      (requestId) =>
        window.__deliver({
          type: "speechToTextError",
          requestId,
          code: "transport_error",
          error: "Synthetic explicit failure",
        }),
      active,
    )
    await expect.poll(() => page.evaluate(() => window.__voice.status())).toBe("degraded")
    expect(
      await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length),
    ).toBe(5)
    const markers = await page.evaluate(
      () => window.__messages.filter((entry) => entry.type === "speechVoiceTurn").length,
    )
    await expect(input).toHaveValue("")
    await page.evaluate(() => window.__session.selectAgent("code", "ses_voice"))
    await input.fill("Typed Code prompt")
    await input.press("Enter")
    await expect.poll(() => captured.length).toBe(3)
    expect(captured[2].request).toBeUndefined()
    expect(captured[2].message.agent).toBe("code")
    expect(
      await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechVoiceTurn").length),
    ).toBe(markers)
    await page.getByRole("button", { name: "Stop hands-free listening", exact: true }).click()
    await page.evaluate(
      (requestId) => window.__deliver({ type: "speechToTextResult", requestId, text: "Retired transcript after Stop" }),
      active,
    )
    const starts = await page.evaluate(
      () => window.__messages.filter((entry) => entry.type === "speechToTextStart").length,
    )
    await page.evaluate(async (requestId) => {
      await window.__deliver({ type: "speechToTextResult", requestId, text: "" })
      await window.__deliver({
        type: "speechToTextError",
        requestId,
        code: "empty_transcript",
        error: "Retired no speech",
      })
    }, active)
    expect(
      await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length),
    ).toBe(starts)
    expect(captured).toHaveLength(3)
    expect(
      await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechVoiceTurn").length),
    ).toBe(markers)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
}, 60_000)
