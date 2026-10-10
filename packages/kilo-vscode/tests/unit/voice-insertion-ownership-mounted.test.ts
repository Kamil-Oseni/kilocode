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
      if (!types.isIdentifier(path.node.key, { name: "ready" })) return
      const parent = path.findParent(
        (value) => value.isVariableDeclarator() && types.isIdentifier(value.node.id, { name: "transcribeAndSend" }),
      )
      if (!parent || !types.isArrowFunctionExpression(path.node.value)) return
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

async function mounted(sending = false, reverse = false, command = false) {
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
  let epoch: string | undefined
  let admitted = false
  let loaded = 0
  let promoted = 0
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
    await page.evaluate(() => {
      window.__session.selectAgent("code")
      window.__session.selectModel("kilo", "synthetic-pinned-4b")
    })
    await page.getByRole("button", { name: "Start hands-free voice", exact: true }).click()
    const draft = await page.evaluate(
      () => window.__messages.findLast((entry) => entry.type === "createSession").draftID,
    )
    await page.evaluate(
      (draftID) => window.__deliver({ type: "sessionCreated", draftID, session: { id: "ses_voice", title: "Voice" } }),
      draft,
    )
    await expect.poll(() => page.evaluate(() => window.__session.currentSessionID())).toBe("ses_voice")
    await expect(input).toHaveValue("")
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
    await expect.poll(() => promoted).toBe(1)
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
      await expect.poll(() => dispatched.length).toBe(1)
      expect(dispatched[0]).toMatchObject({
        text: "Speech after genuine first owner claim",
        sessionID: "ses_voice",
        agent: "voice",
        modelID: "synthetic-pinned-4b",
      })
      await expect(input).toHaveValue("")
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
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("rayaVoiceListen")))
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
      .evaluate(() => window.__unmount())
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
