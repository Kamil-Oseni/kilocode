import assert from "node:assert/strict"
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import { chromium } from "@playwright/test"
import { resolve } from "node:path"
import { createServer } from "node:http"

// Surrounding session/host signals are controlled; the provider and player are
// the actual production modules. Playback uses the browser's real muted PCM sink.
const bundle = await build({
  stdin: {
    contents: `import { createComponent, createSignal } from 'solid-js';
      import { render } from 'solid-js/web';
      import { VoiceProvider, useVoice } from './webview-ui/src/context/voice';
      import { DEFAULT_SPEECH_SETTINGS } from './src/shared/speech';
      window.mount = node => render(() => createComponent(VoiceProvider, {
        get children() { window.fixture.voice = useVoice(); return null; }
      }), node);
      window.signal = createSignal; window.defaults = DEFAULT_SPEECH_SETTINGS;`,
    resolveDir: resolve("."),
    loader: "tsx",
  },
  write: false,
  bundle: true,
  platform: "browser",
  format: "iife",
  plugins: [
    {
      name: "surrounding-contexts",
      setup(builder) {
        builder.onResolve({ filter: /^\.\/(vscode|session)$/ }, (args) => {
          if (!args.importer.replaceAll("\\", "/").endsWith("context/voice.tsx")) return
          return { path: args.path, namespace: "fixture" }
        })
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents:
            args.path === "./vscode"
              ? "export const useVSCode = () => window.fixture.host"
              : "export const useSession = () => window.fixture.session",
          loader: "js",
        }))
      },
    },
    solidPlugin(),
  ],
})
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html")
  response.end('<!doctype html><main id="root"></main>')
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
try {
  const browser = await chromium.launch({
    headless: true,
    args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"],
  })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const result = await page.evaluate(async () => {
      const checks = []
      const check = (value, label) => {
        if (!value) throw new Error(label)
        checks.push(label)
      }
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const until = async (body) => {
        const end = Date.now() + 5000
        while (!body()) {
          if (Date.now() > end) throw new Error("Original playback did not reach its expected state")
          await sleep(10)
        }
      }
      // Exercise direct native AudioContext playout without creating capture devices.
      Object.defineProperty(window, "RTCPeerConnection", { value: undefined })
      const [current, select] = window.signal("voice-one")
      const [draft, stage] = window.signal(undefined)
      const posts = []
      const handlers = new Set()
      const activity = { listens: 0, suspends: 0 }
      window.addEventListener("rayaVoiceListen", () => activity.listens++)
      window.addEventListener("rayaVoiceSuspend", () => activity.suspends++)
      window.fixture = {
        session: { currentSessionID: current, draftSessionID: draft },
        host: {
          postMessage: (row) => posts.push(row),
          onMessage: (handler) => {
            handlers.add(handler)
            return () => handlers.delete(handler)
          },
        },
      }
      const send = (message) => handlers.forEach((handler) => handler(message))
      const dispose = window.mount(document.getElementById("root"))
      const voice = window.fixture.voice
      send({
        type: "speechSettingsLoaded",
        settings: {
          ...window.defaults,
          voiceEngine: "cascade-v1",
          mode: "hands-free",
          hasOpenAIKey: false,
          hasRealtimeKey: false,
          hasSttKey: false,
          hasTtsKey: false,
        },
      })
      voice.listen()
      await sleep(0)
      const release = voice.seal("voice-one")
      check(typeof release === "function" && !voice.captureAllowed(), "Original transcription is sealed")
      await sleep(0)
      check(activity.suspends === 1, "Seal suspends capture once without cancellation")
      voice.wait("voice-one")
      const request = posts.findLast((row) => row.type === "speechVoiceTurn").requestId
      release()
      check(!voice.captureAllowed(), "Accepted output makes the original release inert")
      const count = activity.listens
      voice.hear()
      voice.listen()
      check(voice.status() === "thinking" && activity.listens === count, "Noisy VAD cannot reopen thinking")
      const bytes = new Uint8Array(16000)
      const raw = Array.from(bytes, (value) => String.fromCharCode(value)).join("")
      send({ type: "speechPlaybackChunk", requestId: request, mime: "audio/pcm;rate=16000", data: btoa(raw) })
      check(voice.playing() && voice.status() === "speaking", "Original PCM enters speaking")
      voice.hear()
      voice.listen()
      check(!voice.captureAllowed() && activity.listens === count, "Playback cannot barge in or resume capture")
      send({ type: "speechPlaybackDone", requestId: request })
      check(voice.playing() && !voice.captureAllowed(), "Done does not bypass actual queued PCM")
      await until(() => !voice.playing())
      check(!voice.captureAllowed(), "Actual queue drain still holds echo tail")
      send({ type: "speechPlaybackDone", requestId: request })
      send({ type: "speechPlaybackChunk", requestId: request, mime: "audio/pcm;rate=16000", data: btoa(raw) })
      await sleep(200)
      check(!voice.captureAllowed() && !voice.playing(), "Duplicate Done and late chunk cannot bypass tail")
      await until(() => voice.captureAllowed())
      check(activity.listens === count + 1 && voice.status() === "listening", "Original drain and tail reopen once")
      const abandoned = voice.seal("voice-one")
      voice.stop()
      voice.listen()
      const replacement = voice.seal("voice-one")
      abandoned()
      check(!voice.captureAllowed(), "Old release cannot clear a new same-session turn")
      replacement()
      check(voice.captureAllowed(), "Known no-output refusal releases its own turn")
      voice.seal("voice-one")
      voice.wait("voice-one")
      const stale = posts.findLast((row) => row.type === "speechVoiceTurn").requestId
      send({ type: "speechPlaybackDone", requestId: stale })
      voice.stop()
      await sleep(600)
      check(voice.status() === "off" && !voice.playing(), "Stop during tail never resurrects listening")
      voice.listen()
      voice.seal("voice-one")
      voice.wait("voice-one")
      select("voice-two")
      await sleep(0)
      check(voice.status() === "off", "Changing the actual session retires the turn")
      select("voice-one")
      voice.listen()
      voice.seal("voice-one")
      voice.wait("voice-one")
      const failed = posts.findLast((row) => row.type === "speechVoiceTurn").requestId
      send({ type: "speechPlaybackError", requestId: failed, error: "Owned synthetic output failure" })
      check(voice.status() === "degraded" && !voice.playing(), "Output failure stops capture for manual recovery")
      voice.stop()
      select(undefined)
      stage("pending-voice")
      voice.listen()
      voice.seal("pending-voice")
      voice.wait("pending-voice")
      const pending = posts.findLast((row) => row.type === "speechVoiceTurn").requestId
      select("adopted-voice")
      send({ type: "sessionCreated", draftID: "pending-voice", session: { id: "adopted-voice" } })
      await sleep(0)
      send({ type: "speechPlaybackDone", requestId: pending })
      await until(() => voice.captureAllowed())
      check(voice.status() === "listening", "Exact pending receipt survives genuine session adoption")
      voice.seal("adopted-voice")
      voice.wait("adopted-voice")
      const disposed = posts.findLast((row) => row.type === "speechVoiceTurn").requestId
      send({ type: "speechPlaybackDone", requestId: disposed })
      const before = activity.listens
      dispose()
      await sleep(600)
      check(activity.listens === before, "Disposal retires the original tail timer")
      return checks
    })
    assert.equal(result.length, 17)
    console.log("17 actual half-duplex provider assertions passed")
  } finally {
    await browser.close()
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}
