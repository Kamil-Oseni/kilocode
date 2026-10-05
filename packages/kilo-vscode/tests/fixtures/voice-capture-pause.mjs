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
                return null
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
try {
  send({ type: "speechSettingsLoaded", settings })
  await tick()
  voice.start("synthetic-voice")
  const contexts = audio
  voice.wait("synthetic-voice")
  assert.equal(voice.status(), "thinking")
  voice.setMode("off")
  voice.setMode("hands-free")
  const count = listens
  voice.pause("No speech was detected.")
  await tick()
  assert.equal(listens, count, "queued listen must not cross pause")
  assert.equal(voice.status(), "degraded")
  send({ type: "speechPlaybackChunk", requestId: "old-output", text: "old reply", data: "AA==", mime: "audio/wav" })
  send({ type: "speechPlaybackDone", requestId: "old-output" })
  send({ type: "speechPlaybackVoice", requestId: "old-output", model: "synthetic", voice: "old" })
  send({ type: "speechPlaybackError", requestId: "old-output", error: "old error" })
  send({ type: "speechRealtimeError", fallback: "cascade-v1", error: "old fallback" })
  send({ type: "speechRealtimeStopped" })
  send({ type: "speechSettingsLoaded", settings })
  await tick()
  assert.equal(voice.status(), "degraded", "late chunk/settings must retain paused state")
  assert.equal(voice.error(), "No speech was detected.")
  assert.equal(voice.playing(), false)
  assert.equal(listens, count)
  assert.equal(audio, contexts, "paused late chunk must not authorize another audio context")
  voice.test()
  assert.ok(
    sent.some((row) => row.type === "speechPlaybackStart"),
    "explicit Test voice remains available",
  )
  assert.equal(voice.error(), undefined)
  assert.equal(audio, contexts + 1, "manual Test voice authorizes exactly one replacement synthetic sink")
  console.log("11 actual VoiceProvider pause assertions passed")
} finally {
  dispose()
  await tick()
  await window.happyDOM.close()
}
