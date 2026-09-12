import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"

const cwd = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const server = spawn("bun", ["tests/fixtures/composer-serve.cjs"], {
  cwd,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
})
const chunks = []
server.stdout.on("data", (chunk) => chunks.push(chunk))
server.stderr.on("data", (chunk) => chunks.push(chunk))
const started = Date.now()
while (Date.now() - started < 90_000) {
  try {
    const response = await fetch("http://127.0.0.1:5201/")
    if (response.ok) break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (server.exitCode !== null) throw new Error(Buffer.concat(chunks).toString() || "Composer fixture server exited")
}
if (Date.now() - started >= 90_000) throw new Error("Composer fixture server did not start")

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 1050 } })
  await page.goto("http://127.0.0.1:5201/?live&theme=dark")
  await page.evaluate(() => window.__configureVoice())
  const summary = page.locator('.composer-configuration [data-slot="collapsible-trigger"]')
  assert.match(await summary.textContent(), /Auto/)
  await page.getByRole("button", { name: "Start voice", exact: true }).click()
  const request = await page.evaluate(() =>
    window.__composerMessages.find((message) => message.type === "speechOpenAIStart"),
  )
  assert.equal(request.engine, "live")
  assert.equal(request.sessionID, "first")
  assert.match(await summary.textContent(), /Auto/)
  await page.evaluate(
    (requestId) => window.postMessage({ type: "speechOpenAIReady", requestId, sdp: "local-answer" }, "*"),
    request.requestId,
  )
  const controls = page.getByRole("group", { name: "Voice controls" })
  await controls.waitFor()
  assert.equal(await controls.getByRole("button", { name: "Mute microphone", exact: true }).isDisabled(), true)
  await page.evaluate(
    (requestId) => window.postMessage({ type: "speechLiveStarted", requestId: "stale" }, "*"),
    request.requestId,
  )
  assert.equal(await controls.getByRole("button", { name: "Mute microphone", exact: true }).isDisabled(), true)
  await page.evaluate(
    (requestId) => window.postMessage({ type: "speechLiveStarted", requestId }, "*"),
    request.requestId,
  )
  await controls.getByRole("button", { name: "Mute microphone", exact: true }).click()
  assert.equal(await page.evaluate(() => window.__voiceMicrophone), true)
  const mute = await page.evaluate(() =>
    window.__composerMessages.filter((message) => message.type === "speechLiveControl").at(-1),
  )
  assert.equal(mute.action, "mute")
  await controls.getByRole("button", { name: "Unmute microphone", exact: true }).click()
  const unmute = await page.evaluate(() =>
    window.__composerMessages.filter((message) => message.type === "speechLiveControl").at(-1),
  )
  assert.equal(unmute.action, "unmute")
  await page.evaluate(
    (eventID) =>
      window.postMessage(
        { type: "speechLiveControlResult", requestId: window.__composerMessages.find((message) => message.type === "speechOpenAIStart").requestId, eventID, status: "failed", error: "Stale mute failed" },
        "*",
      ),
    mute.eventID,
  )
  assert.equal((await page.locator(".prompt-realtime-voice").innerText()).includes("Stale mute failed"), false)
  await page.evaluate(
    ([requestId, eventID]) =>
      window.postMessage(
        { type: "speechLiveControlResult", requestId, eventID, status: "failed", error: "Latest unmute failed" },
        "*",
      ),
    [request.requestId, unmute.eventID],
  )
  await page.getByText("Latest unmute failed").waitFor()
  await controls.getByRole("button", { name: "Stop speaking", exact: true }).click()
  await page.getByRole("button", { name: "Resume voice audio", exact: true }).waitFor()
  assert.equal(await controls.getByRole("button", { name: "Stop speaking", exact: true }).isDisabled(), true)
  await page.evaluate(() =>
    window.__liveTransport.sink.captions({
      fragments: Array.from({ length: 65 }, (_, index) => ({
        id: `cap-${index}`,
        speaker: index % 2 ? "assistant" : "user",
        text: `Caption ${index}`,
        start: index,
        end: index + 1,
        sequence: index + 1,
      })),
      incomplete: false,
      limited: false,
    }),
  )
  await page.getByText("Showing the latest 64 caption fragments; this is not the full retained history.").waitFor()
  await page.getByText("Live captions; generated words do not confirm audio playback.").waitFor()
  assert.equal(await page.getByRole("button", { name: "Resume voice audio", exact: true }).isVisible(), true)
  await page.getByRole("button", { name: "Resume voice audio", exact: true }).click()
  assert.equal(await page.getByRole("button", { name: "Resume voice audio", exact: true }).count(), 0)
  await page.evaluate(
    ([requestId, sessionID]) =>
      window.postMessage(
        { type: "speechLiveUsage", requestId, sessionID: "second", usage: { final: true, recorded: true, incomplete: false, seconds: 9 } },
        "*",
      ),
    [request.requestId, request.sessionID],
  )
  assert.equal(await page.locator('[data-slot="live-voice-usage"]').count(), 0)
  await page.evaluate(
    ([requestId, sessionID]) =>
      window.postMessage(
        { type: "speechLiveUsage", requestId, sessionID, usage: { final: true, recorded: true, incomplete: false, seconds: 12.5 } },
        "*",
      ),
    [request.requestId, request.sessionID],
  )
  await page.getByText("Live voice: 12.5 seconds reported").waitFor()
  await page.getByText("Images go to Raya work and its vision model, not GPT-Live.").waitFor()
  await page.getByRole("button", { name: "Switch session", exact: true }).click()
  assert.equal(await page.locator('[data-slot="live-voice-usage"]').count(), 0)
  assert.equal(await page.locator('[data-slot="live-transcript"]').count(), 0)
  assert.match(await summary.textContent(), /Auto/)
  assert.equal(await page.evaluate(() => window.__workStops), 0)
  const prior = await page.evaluate(() => window.__composerMessages.length)
  await page.evaluate(() => window.postMessage({ type: "connectionState", state: "disconnected" }, "*"))
  await page.waitForFunction((n) => window.__composerMessages.length > n, prior)
  const halt = await page.evaluate(() => {
    const stop = window.__composerMessages.filter((message) => message.type === "speechOpenAIStop").at(-1)
    const mic = window.__composerMessages.filter((message) => message.type === "speechLiveMicStop").at(-1)
    return { stop: stop?.requestId, mic: mic?.requestId, stopped: window.__voiceStopped }
  })
  assert.equal(halt.stop, request.requestId)
  assert.equal(halt.mic, request.requestId)
  assert.ok(halt.stopped >= 1)
  assert.equal(await page.getByRole("group", { name: "Voice controls" }).count(), 0)
  await page.evaluate(
    (requestId) => window.postMessage({ type: "speechLiveStarted", requestId }, "*"),
    request.requestId,
  )
  assert.equal(await page.getByRole("group", { name: "Voice controls" }).count(), 0)
  assert.equal(await page.getByRole("button", { name: "Start voice", exact: true }).isDisabled(), true)
  await page.getByText("Previous voice cleanup is still unconfirmed. Restart Raya if cleanup does not finish.").waitFor()
  await page.evaluate(
    (requestId) => window.postMessage({ type: "speechOpenAIStopped", requestId }, "*"),
    request.requestId,
  )
  await page.evaluate(() => window.postMessage({ type: "connectionState", state: "connected" }, "*"))
  await page.getByRole("button", { name: "Start voice", exact: true }).click()
  const second = await page.evaluate(() =>
    window.__composerMessages.filter((message) => message.type === "speechOpenAIStart").at(-1),
  )
  assert.equal(second.engine, "live")
  assert.notEqual(second.requestId, request.requestId)
  await page.evaluate(
    (requestId) => window.postMessage({ type: "speechOpenAIReady", requestId, sdp: "local-answer" }, "*"),
    second.requestId,
  )
  await page.evaluate(
    (requestId) => window.postMessage({ type: "speechLiveStarted", requestId }, "*"),
    second.requestId,
  )
  await page.getByRole("group", { name: "Voice controls" }).waitFor()
  const swapped = await page.evaluate(() => window.__composerMessages.length)
  await page.evaluate(() =>
    window.postMessage(
      {
        type: "speechSettingsLoaded",
        settings: {
          voiceEngine: "openai-realtime",
          openaiVoice: "marin",
          realtimeEndpoint: "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime",
          realtimeModel: "qwen-audio-3.0-realtime-plus",
          realtimeVoice: "longanqian",
          mediaFrontendURL: "http://127.0.0.1:7890",
          sttEndpoint: "",
          sttModel: "SenseVoice-Small",
          ttsEndpoint: "wss://api.minimax.io/ws/v1/t2a_v2",
          ttsModel: "speech-2.6-turbo",
          voice: "English_Graceful_Lady",
          mode: "push-to-talk",
          autoSpeak: true,
          cliMirror: false,
          vadThreshold: 0.025,
          vadSilenceMs: 900,
          hasOpenAIKey: true,
          hasRealtimeKey: false,
          hasSttKey: false,
          hasTtsKey: false,
        },
      },
      "*",
    ),
  )
  await page.waitForFunction((n) => window.__composerMessages.length > n, swapped)
  const change = await page.evaluate(() => {
    const stop = window.__composerMessages.filter((message) => message.type === "speechOpenAIStop").at(-1)
    const start = window.__composerMessages.filter((message) => message.type === "speechOpenAIStart").at(-1)
    return { stop: stop?.requestId, start: start?.requestId, engine: start?.engine }
  })
  assert.equal(change.stop, second.requestId)
  assert.equal(change.start, second.requestId)
  assert.equal(change.engine, "live")
  assert.equal(await page.getByRole("group", { name: "Voice controls" }).count(), 0)
  await page.evaluate(
    (requestId) =>
      window.postMessage(
        { type: "speechRealtimeReady", connection: { id: "stale", livekitURL: "ws://unused", clientToken: "unused", engine: "qwen-realtime", acceptsTruncation: false } },
        "*",
      ),
    second.requestId,
  )
  assert.equal(await page.getByRole("group", { name: "Voice controls" }).count(), 0)
  console.log("Live VoiceProvider UI: 31 implementation assertions passed")
} finally {
  await browser.close()
  server.kill()
}
