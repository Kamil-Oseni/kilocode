import { test } from "bun:test"
import { build } from "esbuild"
import { chromium, expect } from "@playwright/test"
import { transformAsync, types, type PluginObj } from "@babel/core"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
const require = createRequire(import.meta.url)

// Observe each original gate once without replacing its expression or && short circuit.
const gates: PluginObj = {
  visitor: {
    ObjectProperty(path) {
      const parent = path.findParent(
        (value) => value.isVariableDeclarator() && types.isIdentifier(value.node.id, { name: "transcribeAndSend" }),
      )
      if (!parent || !types.isArrowFunctionExpression(path.node.value)) return
      if (types.isIdentifier(path.node.key, { name: "done" })) {
        if (!types.isExpression(path.node.value.body)) throw new Error("Original speech send callback changed")
        // Observe original Promise completion; preserve its value, rejection and all production send logic.
        path.node.value.body = types.callExpression(
          types.memberExpression(path.node.value.body, types.identifier("finally")),
          [
            types.arrowFunctionExpression(
              [],
              types.callExpression(
                types.memberExpression(types.identifier("window"), types.identifier("__speechGate")),
                [types.numericLiteral(14), types.booleanLiteral(true)],
              ),
            ),
          ],
        )
        return
      }
      if (!types.isIdentifier(path.node.key, { name: "ready" })) return
      let index = 0
      const wrap = (value: import("@babel/types").Expression): import("@babel/types").Expression => {
        if (types.isLogicalExpression(value, { operator: "&&" }))
          return types.logicalExpression("&&", wrap(value.left), wrap(value.right))
        return types.callExpression(
          types.memberExpression(types.identifier("window"), types.identifier("__speechGate")),
          [types.numericLiteral(index++), value],
        )
      }
      if (!types.isExpression(path.node.value.body))
        throw new Error("Actual speech readiness is no longer an expression")
      path.node.value.body = wrap(path.node.value.body)
      if (index !== 14) throw new Error("Actual speech readiness diagnostic gate count changed")
    },
  },
}

async function mounted(
  sending = false,
  reverse = false,
  command = false,
  fresh = false,
  ordinary = false,
  action = "",
) {
  const orb = action === "orb" || action === "halfduplex" || action === "tabs"
  const root = resolve(import.meta.dir, "../..")
  const dir = resolve(root, "node_modules/.cache/voice-insertion-ownership-mounted")
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
              plugins: args.path.endsWith("PromptInput.tsx") ? [gates] : [],
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
  await page.addInitScript((value) => {
    window.__tabs = value
  }, action === "tabs")
  let epoch: string | undefined
  let admitted = false
  let loaded = 0
  let promoted = 0
  let changed = 0
  let primary: unknown
  let stage = "first-owner"
  const errors: string[] = []
  page.on("pageerror", (err) => {
    if (errors.length < 16) errors.push(err.message.slice(0, 192))
  })
  const dispatched: Record<string, unknown>[] = []
  try {
    await using storage = await (await import("../fixtures/durable-draft-storage")).draftStorage()
    await page.exposeFunction("__host", async (message) => {
      if (message.type === "composerDraftPane") {
        epoch = message.epoch
        if (!admitted) return
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
        if (
          action === "agent" &&
          !changed &&
          message.type === "composerDraftSave" &&
          message.content.text === "Speech after genuine first owner claim" &&
          !reply.error
        ) {
          // The original physical save has completed; hold its acknowledgement across a real selection change.
          expect(message.content.agent).toBe("voice")
          expect(
            await page.evaluate(() => {
              window.__session.setSessionAgent("ses_voice", "code")
              return window.__session.selectedAgent("ses_voice")
            }),
          ).toBe("code")
          changed++
        }
        await page.evaluate(
          (value) => {
            if (window.__speechGuards.length < 128) window.__speechGuards.push(value)
          },
          { phase: "draft-reply", operation: message.type, error: reply.error, entry: !!reply.entry },
        )
        await page.evaluate((reply) => window.__deliver(reply), reply)
        if (message.type === "composerDraftLoad") loaded++
        if (message.type === "composerDraftPromote" && !reply.error) promoted++
      }
      if (message.type === "copyToClipboard")
        await page.evaluate(
          (id) =>
            window.__deliver({
              type: "clipboardWriteResult",
              id,
              ok: window.__copySuccess === true,
              error: "Synthetic clipboard refusal",
            }),
          message.id,
        )
      if (message.type === "sendMessage") {
        dispatched.push(message)
        if (fresh) {
          if (action) return
          await page.evaluate(
            (draftID) =>
              window.__deliver({ type: "sessionCreated", draftID, session: { id: "ses_voice", title: "New Session" } }),
            message.draftID,
          )
          return
        }
        const receipt = await storage.handle({
          type: "composerDraftClear",
          owner: message.capture.owner,
          epoch: message.capture.epoch,
          generation: message.capture.generation,
          identity: message.capture.identity,
          expected: message.capture.token,
          mutation: `accepted:${message.messageID}`,
          requestID: crypto.randomUUID(),
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
    await page.evaluate((value) => {
      window.__reverse = value
    }, reverse)
    const input = page.locator("textarea.prompt-input")
    await page.getByRole("button", { name: "Start hands-free voice", exact: true }).waitFor()
    await page.evaluate((tabs) => {
      window.__session.selectAgent(tabs ? "auto" : "code")
      window.__session.selectModel("kilo", "synthetic-pinned-4b")
    }, action === "tabs")
    if (fresh) {
      expect(await page.evaluate(() => window.__session.currentSessionID())).toBeUndefined()
      await page.evaluate((ordinary) => window.__voice.setMode(ordinary ? "off" : "hands-free"), ordinary)
      await page.locator(".prompt-speech-button").click()
      expect(await page.evaluate(() => window.__session.currentSessionID())).toBeUndefined()
      expect(await page.evaluate(() => window.__messages.some((entry) => entry.type === "createSession"))).toBe(false)
    } else {
      if (orb) expect(await page.evaluate(() => window.__session.currentSessionID())).toBeUndefined()
      await page.getByRole("button", { name: "Start hands-free voice", exact: true }).click()
      const draft = await page.evaluate(
        () => window.__messages.findLast((entry) => entry.type === "createSession").draftID,
      )
      await page.evaluate(
        ({ draftID, orb }) =>
          window.__deliver({
            type: "sessionCreated",
            draftID,
            session: { id: "ses_voice", title: "Voice", ...(orb ? { agent: "auto" } : {}) },
          }),
        { draftID: draft, orb },
      )
      await expect.poll(() => page.evaluate(() => window.__session.currentSessionID())).toBe("ses_voice")
      if (orb) {
        await expect
          .poll(() =>
            page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechRealtimeStart").length),
          )
          .toBe(1)
        await page.evaluate(async () => {
          await window.__deliver({ type: "messagesLoaded", sessionID: "ses_voice", messages: [], mode: "focus" })
          await window.__deliver({
            type: "sessionUpdated",
            session: { id: "ses_voice", title: "New Session", agent: "auto" },
          })
        })
        expect(await page.evaluate(() => window.__session.selectedAgent("ses_voice"))).toBe("voice")
        if (action === "tabs") {
          await page.evaluate(() =>
            window.__deliver({
              type: "sessionUpdated",
              session: { id: "ses_voice", title: "Intro to Raya's capabilities" },
            }),
          )
          await expect(page.locator("#title")).toHaveText("Intro to Raya's capabilities")
        }
      }
      await expect(input).toHaveValue("")
      await page.evaluate(async () => {
        window.__voice.setMode("hands-free")
        await window.__deliver({
          type: "speechRealtimeError",
          requestId: window.__messages.findLast((entry) => entry.type === "speechRealtimeStart")?.requestId,
          code: "configuration",
          error: "Synthetic cascade admission",
          fallback: "cascade-v1",
        })
      })
    }
    await expect
      .poll(() => page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length))
      .toBe(1)
    const initial = await page.evaluate(
      () => window.__messages.findLast((entry) => entry.type === "speechToTextStart").requestId,
    )
    await page.evaluate((requestId) => window.__deliver({ type: "speechToTextStarted", requestId }), initial)
    if (sending || command) {
      await page.evaluate(
        async ({ requestId, command }) => {
          await window.__deliver({ type: "speechToTextSilence", requestId })
          await window.__deliver({
            type: "speechToTextResult",
            requestId,
            text: command ? "Stop hands-free voice mode" : "Speech after genuine first owner claim",
          })
          await window.__deliver({ type: "speechToTextResult", requestId, text: "Duplicate first claim result" })
        },
        { requestId: initial, command },
      )
      expect(dispatched).toHaveLength(0)
      await expect(input).toHaveValue("")
    }
    if (!epoch) throw new Error("Original real draft epoch missing")
    admitted = true
    await page.evaluate(
      (epoch) =>
        window.__deliver({
          type: "composerDraftState",
          epoch,
          generation: 1,
          connected: true,
          owners: [{ box: "voice-mounted", owner: "synthetic-owned-workspace" }],
        }),
      epoch,
    )
    await expect.poll(() => loaded).toBeGreaterThan(0)
    if (!fresh && action !== "tabs") await expect.poll(() => promoted).toBe(1)
    if (ordinary) {
      await page.locator(".prompt-speech-button").click()
      await page.evaluate(
        (requestId) => window.__deliver({ type: "speechToTextResult", requestId, text: "Ordinary dictated draft" }),
        initial,
      )
      await expect(input).toHaveValue("Ordinary dictated draft")
      expect(await page.evaluate(() => window.__session.selectedAgent())).toBe("code")
      expect(dispatched).toHaveLength(0)
      expect(await page.evaluate(() => window.__messages.some((entry) => entry.type === "speechVoiceTurn"))).toBe(false)
      await page.evaluate(() =>
        window.__deliver({ type: "sessionCreated", session: { id: "ses_ordinary", title: "Ordinary session" } }),
      )
      expect(errors).toEqual([])
      expect(await page.evaluate(() => window.__voice.playing())).toBe(false)
      expect(await page.evaluate(() => window.__messages.some((entry) => entry.type === "speechVoiceTurn"))).toBe(false)
      return
    }
    if (!sending && !command)
      await page.evaluate(
        async ({ requestId, sending }) => {
          await window.__deliver({ type: "speechToTextSilence", requestId })
          if (!sending)
            await window.__deliver({
              type: "appendReviewComments",
              autoSend: false,
              comments: [
                {
                  id: "retained-comment",
                  file: "fixture.ts",
                  side: "additions",
                  line: 1,
                  comment: "Keep this review",
                  selectedText: "fixture",
                },
              ],
            })
          await window.__deliver({
            type: "speechToTextResult",
            requestId,
            text: "Speech after genuine first owner claim",
          })
          await window.__deliver({ type: "speechToTextResult", requestId, text: "Duplicate first claim result" })
        },
        { requestId: initial, sending },
      )
    if (command) {
      await expect.poll(() => page.evaluate(() => window.__voice.status())).toBe("off")
      expect(dispatched).toHaveLength(0)
      await expect(input).toHaveValue("")
      await expect(page.locator('[data-slot="speech-recovery"]')).toHaveCount(0)
      expect(
        await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechRealtimeStop").length),
      ).toBeGreaterThan(0)
      expect(
        await page.evaluate(
          () =>
            window.__messages.filter((entry) => entry.type === "sendMessage" || entry.type === "speechVoiceTurn")
              .length,
        ),
      ).toBe(0)
      return
    }
    if (sending) {
      if (action === "agent") {
        await expect.poll(() => changed).toBe(1)
        await expect
          .poll(() =>
            page.evaluate(() => window.__speechGates.filter((entry) => entry.index === 14 && entry.accepted).length),
          )
          .toBe(1)
        expect(dispatched).toHaveLength(0)
        expect(await page.evaluate(() => window.__messages.some((entry) => entry.type === "speechVoiceTurn"))).toBe(
          false,
        )
        await expect(input).toHaveValue("Speech after genuine first owner claim")
        await page.evaluate(() => window.__voice.stop())
        expect(errors).toEqual([])
        return
      }
      await expect.poll(() => dispatched.length).toBe(1)
      expect(dispatched[0]).toMatchObject({
        text: "Speech after genuine first owner claim",
        ...(fresh ? {} : { sessionID: "ses_voice" }),
        agent: "voice",
        modelID: "synthetic-pinned-4b",
      })
      if (action === "tabs") expect(dispatched[0].draftID).toBeUndefined()
      if (orb) {
        const marker = await page.evaluate(() =>
          window.__messages.findLast((entry) => entry.type === "speechVoiceTurn"),
        )
        expect(marker).toMatchObject({ sessionID: "ses_voice" })
        expect(marker.draftID).toBeUndefined()
        expect(marker.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
        expect(dispatched[0].capture).toMatchObject({ identity: { sessionID: "ses_voice" } })
        const order = await page.evaluate(() => window.__messages.map((entry) => entry.type))
        expect(order.indexOf("speechVoiceTurn")).toBeLessThan(order.indexOf("sendMessage"))
      }
      if (action === "halfduplex") {
        const marker = await page.evaluate(() =>
          window.__messages.findLast((entry) => entry.type === "speechVoiceTurn"),
        )
        const cancels = await page.evaluate(
          () => window.__messages.filter((entry) => entry.type === "speechPlaybackCancel").length,
        )
        await page.evaluate(async (requestId) => {
          window.dispatchEvent(new CustomEvent("rayaVoiceListen"))
          await window.__deliver({ type: "speechToTextSpeech", requestId })
          await window.__deliver({ type: "speechToTextResult", requestId, text: "Late microphone echo" })
        }, initial)
        expect(dispatched).toHaveLength(1)
        expect(
          await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length),
        ).toBe(1)
        await page.evaluate(async (requestId) => {
          await window.__deliver({
            type: "messageCreated",
            message: {
              id: "halfduplex_reply",
              sessionID: "ses_voice",
              parentID: window.__messages.findLast((entry) => entry.type === "sendMessage").messageID,
              role: "assistant",
              agent: "voice",
              finish: "stop",
              time: { created: 1, completed: 2 },
            },
          })
          await window.__deliver({ type: "sessionStatus", sessionID: "ses_voice", status: "idle" })
          await window.__deliver({
            type: "speechPlaybackChunk",
            requestId,
            data: btoa(String.fromCharCode(...new Uint8Array(16_000))),
            mime: "audio/pcm;rate=16000",
          })
        }, marker.requestId)
        await expect.poll(() => page.evaluate(() => window.__voice.playing())).toBe(true)
        await page.evaluate(async (requestId) => {
          window.dispatchEvent(new CustomEvent("rayaVoiceListen"))
          await window.__deliver({ type: "speechToTextSpeech", requestId })
          await window.__deliver({
            type: "speechToTextResult",
            requestId,
            text: "Speaker audio cannot become a user turn",
          })
        }, initial)
        expect(dispatched).toHaveLength(1)
        expect(
          await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechPlaybackCancel").length),
        ).toBe(cancels)
        expect(
          await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length),
        ).toBe(1)
        await page.evaluate(
          (requestId) => window.__deliver({ type: "speechPlaybackDone", requestId }),
          marker.requestId,
        )
        await expect
          .poll(() =>
            page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length),
          )
          .toBe(2)
        const next = await page.evaluate(
          () => window.__messages.findLast((entry) => entry.type === "speechToTextStart").requestId,
        )
        expect(next).not.toBe(initial)
        await page.evaluate(async (requestId) => {
          await window.__deliver({ type: "speechToTextStarted", requestId })
          await window.__deliver({ type: "speechToTextSilence", requestId })
          await window.__deliver({
            type: "speechToTextResult",
            requestId,
            text: "Next genuine user turn after audio drain",
          })
        }, next)
        await expect.poll(() => dispatched.length).toBe(2)
        expect(dispatched[1]).toMatchObject({
          agent: "voice",
          sessionID: "ses_voice",
          text: "Next genuine user turn after audio drain",
        })
        await page.evaluate(() => window.__voice.stop())
        await page.evaluate(async (requestId) => {
          window.dispatchEvent(new CustomEvent("rayaVoiceListen"))
          await window.__deliver({ type: "speechToTextResult", requestId, text: "Stopped late result" })
        }, next)
        expect(dispatched).toHaveLength(2)
        expect(await page.evaluate(() => window.__voice.status())).toBe("off")
        expect(errors).toEqual([])
        return
      }
      if (fresh) {
        expect(dispatched[0].sessionID).toBeUndefined()
        expect(dispatched[0].capture).toMatchObject({ identity: { pendingID: dispatched[0].draftID } })
        const marker = await page.evaluate(() =>
          window.__messages.findLast((entry) => entry.type === "speechVoiceTurn"),
        )
        expect(marker).toMatchObject({ draftID: dispatched[0].draftID })
        expect(marker.sessionID).toBeUndefined()
        const order = await page.evaluate(() => window.__messages.map((entry) => entry.type))
        expect(order.indexOf("speechVoiceTurn")).toBeLessThan(order.indexOf("sendMessage"))
        if (action) {
          await page.evaluate((action) => {
            if (action === "stop") window.__voice.stop()
            if (action === "replace") window.__session.setDraftSessionID("pending:replacement")
            if (action === "foreign") window.__session.setCurrentSessionID("ses_foreign")
          }, action)
          await expect.poll(() => page.evaluate(() => window.__voice.status())).toBe("off")
          await page.evaluate(async (requestId) => {
            await window.__deliver({
              type: "speechPlaybackChunk",
              requestId,
              data: "AAA=",
              mime: "audio/pcm;rate=16000",
            })
            await window.__deliver({ type: "speechPlaybackDone", requestId })
          }, marker.requestId)
          expect(await page.evaluate(() => window.__voice.playing())).toBe(false)
          expect(await page.evaluate(() => window.__voice.status())).toBe("off")
          expect(dispatched).toHaveLength(1)
          return
        }
        await page.evaluate(async () => {
          await window.__deliver({ type: "sessionStatus", sessionID: "ses_voice", status: "busy" })
          await window.__deliver({
            type: "sessionUpdated",
            session: { id: "ses_voice", title: "Initial capabilities check", updatedAt: "2026-10-10T15:40:46.708Z" },
          })
          await window.__deliver({ type: "sessionStatus", sessionID: "ses_voice", status: "idle" })
          await window.__deliver({
            type: "messageCreated",
            message: {
              id: "voice_reply",
              sessionID: "ses_voice",
              parentID: window.__messages.findLast((entry) => entry.type === "sendMessage").messageID,
              role: "assistant",
              agent: "voice",
              finish: "stop",
              time: { created: 1, completed: 2 },
            },
          })
          await window.__deliver({
            type: "partUpdated",
            sessionID: "ses_voice",
            messageID: "voice_reply",
            part: { id: "voice_text", type: "text", messageID: "voice_reply", text: "Owned completed answer" },
          })
        })
        await expect
          .poll(() => page.evaluate(() => window.__session.currentSession().title))
          .toBe("Initial capabilities check")
        expect(await page.evaluate(() => window.__session.status())).toBe("idle")
        expect(await page.evaluate(() => window.__session.submitting())).toBe(false)
        expect(await page.evaluate(() => window.__session.getParts("voice_reply"))).toEqual([
          { id: "voice_text", type: "text", messageID: "voice_reply", text: "Owned completed answer" },
        ])
        await page.evaluate(() => window.__session.setCurrentSessionID("ses_foreign"))
        await expect.poll(() => page.evaluate(() => window.__voice.status())).toBe("off")
        await page.evaluate(async (requestId) => {
          await window.__deliver({ type: "speechPlaybackChunk", requestId, data: "AAA=", mime: "audio/pcm;rate=16000" })
          await window.__deliver({ type: "speechPlaybackDone", requestId })
        }, marker.requestId)
        expect(await page.evaluate(() => window.__voice.playing())).toBe(false)
        expect(await page.evaluate(() => window.__voice.status())).toBe("off")
      }
      if (!fresh) await expect(input).toHaveValue("")
      expect(
        await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechVoiceTurn").length),
      ).toBe(1)
      expect(await page.evaluate(() => window.__messages.filter((entry) => entry.type === "sendMessage").length)).toBe(
        1,
      )
      await expect(page.locator('[data-slot="speech-recovery"]')).toHaveCount(0)
      return
    }
    await expect(input).toHaveValue("Speech after genuine first owner claim")
    await expect(page.locator('[data-slot="speech-recovery"]')).toHaveCount(0)
    expect(
      await page.evaluate(
        () =>
          window.__messages.filter((entry) => entry.type === "sendMessage" || entry.type === "speechVoiceTurn").length,
      ),
    ).toBe(0)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("rayaVoiceListen")))
    await expect
      .poll(() => page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length))
      .toBe(2)
    const image = await page.evaluate(
      () => window.__messages.findLast((entry) => entry.type === "speechToTextStart").requestId,
    )
    await page.evaluate(async (requestId) => {
      await window.__deliver({ type: "speechToTextStarted", requestId })
      await window.__deliver({ type: "speechToTextSilence", requestId })
      await window.__deliver({
        type: "setChatBoxMessage",
        text: "Speech after genuine first owner claim",
        images: [
          {
            filename: "fixture.png",
            mime: "image/png",
            dataUrl:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP0kAAAAASUVORK5CYII=",
          },
        ],
      })
      await window.__deliver({
        type: "speechToTextResult",
        requestId,
        text: "Image-only changes keep dictation as a draft",
      })
    }, image)
    expect(await input.inputValue()).toContain("Image-only changes keep dictation as a draft")
    await expect(page.locator('[data-slot="speech-recovery"]')).toHaveCount(0)
    expect(
      await page.evaluate(
        () =>
          window.__messages.filter((entry) => entry.type === "sendMessage" || entry.type === "speechVoiceTurn").length,
      ),
    ).toBe(0)
    for (const kind of ["auth", "auth-aba"]) {
      stage = kind
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("rayaVoiceListen")))
      await expect
        .poll(() => page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length))
        .toBe(kind === "auth" ? 3 : 4)
      const request = await page.evaluate(
        () => window.__messages.findLast((entry) => entry.type === "speechToTextStart").requestId,
      )
      await page.evaluate(async (requestId) => {
        await window.__deliver({ type: "speechToTextStarted", requestId })
        await window.__deliver({ type: "speechToTextSilence", requestId })
      }, request)
      await page.evaluate(() => window.__auth({ fixture: "api" }))
      if (kind === "auth-aba") await page.evaluate(() => window.__auth({}))
      await page.evaluate(
        async ({ requestId, kind }) => {
          await window.__deliver({ type: "speechToTextResult", requestId, text: `Retained ${kind} transcript` })
        },
        { requestId: request, kind },
      )
      await expect.poll(() => input.inputValue()).toContain(`Retained ${kind} transcript`)
      await expect(page.locator('[data-slot="speech-recovery"]')).toHaveCount(0)
      expect(dispatched).toHaveLength(0)
      if (kind === "auth") await page.evaluate(() => window.__auth({}))
    }
    const kinds = ["newer", "aba", "cursor", "caret-aba", "context", "context-aba", "session-aba", "session"]
    for (const kind of kinds) {
      stage = kind
      await page.evaluate(async () => {
        if (window.__voice.status() !== "off") {
          window.dispatchEvent(new CustomEvent("rayaVoiceListen"))
          return
        }
        // Session excursions now end voice; recording again needs a new explicit owner.
        const id = window.__session.currentSessionID()
        if (!id) throw new Error("Fixture cannot restart voice without an actual selected session")
        window.__voice.start(id)
        await window.__deliver({
          type: "speechRealtimeError",
          requestId: window.__messages.findLast((entry) => entry.type === "speechRealtimeStart")?.requestId,
          code: "configuration",
          error: "Synthetic restarted cascade admission",
          fallback: "cascade-v1",
        })
      })
      await expect
        .poll(() => page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length))
        .toBe(kinds.indexOf(kind) + 5)
      const request = await page.evaluate(
        () => window.__messages.findLast((entry) => entry.type === "speechToTextStart").requestId,
      )
      const original = await input.inputValue()
      await page.evaluate(async (requestId) => {
        await window.__deliver({ type: "speechToTextStarted", requestId })
        await window.__deliver({ type: "speechToTextSilence", requestId })
      }, request)
      if (!["cursor", "caret-aba", "context-aba", "session-aba"].includes(kind))
        await input.fill(kind === "aba" ? `${original} edited` : "Newer typed draft")
      if (kind === "aba") await input.fill(original)
      if (kind === "cursor") {
        await input.evaluate((element) => element.setSelectionRange(0, 0))
      }
      if (kind === "caret-aba") {
        const caret = await input.evaluate((element) => ({ start: element.selectionStart, end: element.selectionEnd }))
        await input.evaluate((element, caret) => {
          const next = caret.start === 0 && caret.end === 0 ? element.value.length : 0
          element.setSelectionRange(next, next)
          element.dispatchEvent(new Event("select", { bubbles: true }))
        }, caret)
        await input.evaluate((element, caret) => {
          element.setSelectionRange(caret.start, caret.end)
          element.dispatchEvent(new Event("select", { bubbles: true }))
        }, caret)
      }
      if (kind === "context") {
        await page.evaluate(() => window.__box("agent-manager:changed-context"))
        await input.fill("Changed context draft")
      }
      if (kind === "context-aba") {
        await page.evaluate(() => window.__box("agent-manager:temporary-context"))
        await page.evaluate(() => window.__box("voice-mounted"))
      }
      if (kind === "session-aba") {
        await page.evaluate(() => window.__session.setCurrentSessionID("ses_temporary"))
        await page.evaluate(() => window.__session.setCurrentSessionID("ses_voice"))
      }
      if (kind === "session") {
        await page.evaluate(() => {
          window.__session.clearCurrentSession()
          window.__session.setDraftSessionID("pending:new-owner")
        })
        await input.fill("New session draft")
      }
      const expected = await input.inputValue()
      await page.evaluate(async (requestId) => {
        await window.__deliver({ type: "speechToTextResult", requestId, text: "Stop hands-free voice mode" })
        await window.__deliver({ type: "speechToTextResult", requestId, text: "Duplicate stale result" })
      }, request)
      await expect(input).toHaveValue(expected)
      const recovery = page.locator('[data-slot="speech-recovery"]')
      await expect(recovery).toContainText("Stop hands-free voice mode")
      await page.evaluate(() => {
        window.__copySuccess = true
      })
      await page.getByRole("button", { name: "Copy transcript", exact: true }).click()
      await expect(recovery).toContainText("Stop hands-free voice mode")
      await page.evaluate(() => {
        window.__copySuccess = false
        window.dispatchEvent(new CustomEvent("rayaVoiceCancel"))
      })
      await expect(recovery).toContainText("Stop hands-free voice mode")
      await expect(recovery).not.toContainText("Duplicate stale result")
      expect(
        await page.evaluate(
          () =>
            window.__messages.filter((entry) => entry.type === "sendMessage" || entry.type === "speechVoiceTurn")
              .length,
        ),
      ).toBe(0)
      expect(await page.evaluate(() => window.__voice.settings().mode)).toBe("hands-free")
      await page.getByRole("button", { name: "Copy transcript", exact: true }).click()
      await expect(recovery).toContainText("Could not copy")
      await expect(recovery).toContainText("Stop hands-free voice mode")
      const count = await page.evaluate(
        () => window.__messages.filter((entry) => entry.type === "speechToTextStart").length,
      )
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("rayaVoiceListen")))
      expect(
        await page.evaluate(() => window.__messages.filter((entry) => entry.type === "speechToTextStart").length),
      ).toBe(count)
      await page.getByRole("button", { name: "Discard transcript", exact: true }).click()
      await expect(recovery).toHaveCount(0)
      if (kind === "context") await page.evaluate(() => window.__box("voice-mounted"))
    }
    await page.evaluate(() => {
      window.__saved.unrelated = { revision: 19 }
      window.__saved.rayaSpeechRecoveryV1 = {
        version: 1,
        request: "restored",
        status: "text",
        text: "Start hands-free voice mode",
        box: "foreign",
        key: "pending:foreign",
        owner: "foreign",
        context: null,
        session: null,
        route: null,
      }
      window.__unmount()
    })
    await page.evaluate(() => window.__mount())
    await expect(page.locator('[data-slot="speech-recovery"]')).toContainText("Start hands-free voice mode")
    expect(
      await page.evaluate(
        () =>
          window.__messages.filter((entry) => entry.type === "sendMessage" || entry.type === "speechVoiceTurn").length,
      ),
    ).toBe(0)
    await page.getByRole("button", { name: "Discard transcript", exact: true }).click()
    expect(await page.evaluate(() => window.__saved.unrelated)).toEqual({ revision: 19 })
  } catch (err) {
    primary = err
    console.error(
      "VOICE_OWNERSHIP_FAILURE",
      JSON.stringify({
        stage,
        sending,
        reverse,
        command,
        loaded,
        promoted,
        dispatched: dispatched.length,
        errors,
        browser: await page
          .evaluate(() => ({
            session: window.__session.currentSessionID(),
            status: window.__voice.status(),
            mode: window.__voice.settings().mode,
            text: document.querySelector("textarea.prompt-input")?.value?.length,
            recovery: document.querySelector('[data-slot="speech-recovery"]')?.textContent?.slice(0, 384),
            saved: window.__saved?.rayaSpeechRecoveryV1?.status,
            guards: window.__speechGuards?.slice(-20),
            gates: window.__speechGates?.slice(-30),
            messages: window.__messages.slice(-20).map((value) => ({
              type: value.type,
              request: value.requestId,
              error: value.error,
              operation: value.operation,
            })),
          }))
          .catch((failure) => ({ diagnostic: failure instanceof Error ? failure.name : "unavailable" })),
      }),
    )
    throw err
  } finally {
    const failures: unknown[] = []
    await page
      .evaluate(() => {
        if (typeof window.__unmount === "function") window.__unmount()
      })
      .catch((err) => {
        failures.push(err)
      })
    await page.close().catch((err) => {
      failures.push(err)
    })
    await browser.close().catch((err) => {
      failures.push(err)
    })
    if (failures.length)
      throw new AggregateError(
        primary === undefined ? failures : [primary, ...failures],
        "Mounted speech test cleanup failed",
      )
  }
}

test("actual mounted speech ownership protects newer and ABA drafts with detached recovery", () => mounted(), 120_000)
test(
  "actual mounted unchanged speech sends once after first owner acknowledgement arrives during recording",
  () => mounted(true),
  120_000,
)
test(
  "actual mounted delayed first-owner speech sends once with reversed subscriber delivery",
  () => mounted(true, true),
  120_000,
)
test(
  "actual mounted owned spoken stop cancels hands-free without retaining a consumed command",
  () => mounted(false, false, true),
  120_000,
)

for (const reverse of [false, true])
  test(
    `actual mounted fresh hands-free mic binds pending Voice submission and projects completed title/idle (${reverse ? "reverse" : "normal"})`,
    () => mounted(true, reverse, false, true),
    120_000,
  )

test(
  "actual mounted speech refuses a changed agent while its original durable capture acknowledgement is delayed",
  () => mounted(true, false, false, false, false, "agent"),
  120_000,
)

test(
  "actual mounted local voice seals thinking and PCM playback until drain before accepting the next user turn",
  () => mounted(true, false, false, false, false, "halfduplex"),
  120_000,
)

test(
  "actual mounted fresh ordinary dictation retains its selected agent without arming Voice output",
  () => mounted(false, false, false, true, true),
  120_000,
)

test.each(["replace", "foreign", "stop"])(
  "actual mounted pending Voice %s retires original playback before session adoption",
  (action) => mounted(true, false, false, true, false, action),
  120_000,
)

for (const reverse of [false, true])
  test(
    `actual mounted empty orb startup retains Voice across default Auto hydration (${reverse ? "reverse" : "normal"})`,
    () => mounted(true, reverse, false, false, false, "orb"),
    120_000,
  )

for (const reverse of [false, true])
  test(
    `actual mounted sidebar orb submits through the created Voice session (${reverse ? "reverse" : "normal"})`,
    () => mounted(true, reverse, false, false, false, "tabs"),
    120_000,
  )
