import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "openai-provider-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(await Bun.file(path).text(), {
        filename: path,
        configFile: false,
        babelrc: false,
        presets: [
          [import.meta.resolve("babel-preset-solid"), { generate: "dom" }],
          import.meta.resolve("@babel/preset-typescript"),
        ],
      })
      if (!result?.code) throw new Error("No compiled component")
      return { contents: result.code, loader: "js" }
    })
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: /\?worker&url$/ }, () => ({ contents: "export default 'test-worker.js'", loader: "js" }))
  },
})
const window = new Window()
for (const name of [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
  "MessageEvent",
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
const sent = []
globalThis.acquireVsCodeApi = () => ({
  postMessage: (msg) => sent.push(msg),
  getState: () => undefined,
  setState: () => {},
})
const { createComponent } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { VoiceProvider, useVoice } = await import("../../webview-ui/src/context/voice.tsx")
const { NativeVoiceControls } = await import("../../webview-ui/src/components/chat/NativeVoiceControls.tsx")
const { DEFAULT_SPEECH_SETTINGS } = await import("../../src/shared/speech.ts")
let audio = 0
globalThis.AudioContext = class {
  constructor() {
    audio++
  }
  async resume() {}
  async close() {}
}
let voice
let listens = 0
window.addEventListener("rayaVoiceListen", () => listens++)
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(SessionContext.Provider, {
          value: { currentSessionID: () => "synthetic-voice" },
          get children() {
            return createComponent(VoiceProvider, {
              get children() {
                voice = useVoice()
                return createComponent(NativeVoiceControls, {
                  end: () => {
                    voice.stop()
                    voice.setMode("off")
                  },
                })
              },
            })
          },
        })
      },
    }),
  root,
)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const send = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))
const settings = {
  ...DEFAULT_SPEECH_SETTINGS,
  hasOpenAIKey: false,
  hasRealtimeKey: false,
  hasSttKey: false,
  hasTtsKey: false,
  voiceEngine: "cascade-v1",
  mode: "hands-free",
}
let cancels = 0
window.addEventListener("rayaVoiceCancel", () => cancels++)
try {
  send({ type: "speechSettingsLoaded", settings })
  await tick()
  voice.start("synthetic-voice")
  const contexts = audio
  voice.wait("synthetic-voice")
  assert.equal(voice.status(), "thinking")
  const stop = root.querySelector('button[aria-label="Stop hands-free listening"]')
  assert.ok(stop, "local hands-free stop must remain visible while thinking")
  assert.equal(stop.disabled, false)
  stop.click()
  assert.equal(voice.status(), "off")
  assert.equal(voice.settings().mode, "off")
  assert.ok(cancels > 0, "stop must synchronously cancel the active capture")
  const count = listens
  const stops = sent.filter((row) => row.type === "speechRealtimeStop").length
  send({ type: "speechRealtimeReady", connection: {} })
  send({ type: "speechPlaybackChunk", requestId: "late", data: "AA==", mime: "audio/wav" })
  send({ type: "speechPlaybackDone", requestId: "late" })
  send({ type: "speechRealtimeError", fallback: "cascade-v1", error: "late fallback" })
  await tick()
  assert.equal(listens, count)
  assert.equal(voice.status(), "off")
  assert.equal(voice.playing(), false)
  assert.equal(audio, contexts, "stopped callbacks must not create another audio context")
  assert.equal(
    sent.filter((row) => row.type === "speechRealtimeStop").length,
    stops + 1,
    "late connection ready must refuse microphone admission",
  )
  voice.setMode("hands-free")
  voice.wait("synthetic-voice")
  voice.pause("Capture failed")
  assert.ok(
    root.querySelector('button[aria-label="Stop hands-free listening"]'),
    "capture failure must retain stop control",
  )
  const paused = listens
  send({ type: "speechSettingsLoaded", settings: { ...settings, mode: "push-to-talk" } })
  send({ type: "speechSettingsLoaded", settings })
  await tick()
  assert.equal(listens, paused, "passive settings cannot restart a stopped/paused capture")
  console.log("13 actual hands-free stop assertions passed")
} finally {
  dispose()
  await tick()
  await window.happyDOM.close()
}
