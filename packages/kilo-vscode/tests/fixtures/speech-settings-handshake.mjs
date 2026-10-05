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
const mode = process.argv[2] ?? "success"
globalThis.acquireVsCodeApi = () => ({
  postMessage: (msg) => {
    sent.push(msg)
    if (
      mode === "success" &&
      msg.type === "speechSettingsRequest" &&
      sent.filter((row) => row.type === "speechSettingsRequest").length === 2
    ) {
      void store
        .load()
        .then((settings) =>
          window.dispatchEvent(
            new window.MessageEvent("message", { data: { type: "speechSettingsLoaded", settings } }),
          ),
        )
    }
  },
  getState: () => undefined,
  setState: () => {},
})
const { createComponent } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { VoiceProvider, useVoice } = await import("../../webview-ui/src/context/voice.tsx")
const { default: SpeechTab } = await import("../../webview-ui/src/components/settings/SpeechTab.tsx")
const { SpeechSettingsStore } = await import("../../src/speech/settings.ts")
const values = new Map()
const keys = new Map()
const store = new SpeechSettingsStore(
  {
    get: (key, fallback) => values.get(key) ?? fallback,
    update: async (key, value) => {
      values.set(key, value)
    },
  },
  {
    get: async (key) => keys.get(key),
    store: async (key, value) => {
      keys.set(key, value)
    },
    delete: async (key) => {
      keys.delete(key)
    },
  },
)
await store.update({
  voiceEngine: "cascade-v1",
  ttsEngine: "local-jobs",
  sttEngine: "local",
  autoSpeak: false,
  cliMirror: false,
})
await store.setKey("local", "synthetic-speech-only-key-123456")
let audio = 0
// No browser audio samples or microphone access; this only detects attempted sink authorization.
globalThis.AudioContext = class {
  destination = {}
  constructor() {
    audio++
  }
  async resume() {}
  async close() {}
}
let media = 0
Object.defineProperty(window.navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: async () => {
      media++
      throw new Error("Settings must not capture audio")
    },
  },
})
let voice
let checks = 0
const check = (value, message) => {
  assert.ok(value, message)
  checks++
}
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(SessionContext.Provider, {
          value: { currentSessionID: () => "settings-fixture" },
          get children() {
            return createComponent(VoiceProvider, {
              get children() {
                voice = useVoice()
                return createComponent(SpeechTab, {})
              },
            })
          },
        })
      },
    }),
  root,
)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const load = async () => {
  window.dispatchEvent(
    new window.MessageEvent("message", { data: { type: "speechSettingsLoaded", settings: await store.load() } }),
  )
  await tick()
}
const button = (name) => {
  const node = root.querySelector(`button[aria-label="${name}"]`)
  assert.ok(node, `Missing button ${name}`)
  return node
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  check(
    sent.filter((row) => row.type === "speechSettingsRequest").length === 1,
    "actual initial read request sent and intentionally dropped",
  )
  if (mode === "baseline") {
    await sleep(1250)
    check(
      sent.filter((row) => row.type === "speechSettingsRequest").length >= 2,
      "dropped initial settings read is retried",
    )
  } else if (mode === "unmount") {
    dispose()
    const count = sent.filter((row) => row.type === "speechSettingsRequest").length
    await sleep(1250)
    check(
      sent.filter((row) => row.type === "speechSettingsRequest").length === count,
      "unmount cancels pending settings retry",
    )
  } else {
    check(voice.startBlocked() === true, "voice is blocked before genuine settings arrive")
    voice.start("settings-fixture")
    voice.test()
    voice.listen()
    voice.update({ autoSpeak: true })
    check(
      !sent.some((row) =>
        [
          "speechSettingsUpdate",
          "speechPlaybackStart",
          "speechOpenAIStart",
          "speechRealtimeStart",
          "speechVoiceTurn",
        ].includes(row.type),
      ),
      "missing settings cannot write defaults or start voice",
    )
    check(audio === 0 && media === 0, "missing settings cannot authorize audio or capture microphone")
    await sleep(1250)
    check(
      sent.filter((row) => row.type === "speechSettingsRequest").length >= 2,
      "actual retry survives dropped first request",
    )
    if (mode === "success") {
      check(
        voice.settings().voiceEngine === "cascade-v1" &&
          voice.settings().ttsEngine === "local-jobs" &&
          voice.settings().hasLocalKey === true,
        "actual persisted local state is loaded after retry",
      )
      check(
        voice.settings().autoSpeak === false && voice.settings().cliMirror === false,
        "quiet saved settings preserved",
      )
      check(voice.startBlocked() === false, "settings acknowledgement releases only loading gate")
      const count = sent.filter((row) => row.type === "speechSettingsRequest").length
      await sleep(1250)
      check(
        sent.filter((row) => row.type === "speechSettingsRequest").length === count,
        "valid load stops all retry requests",
      )
    } else {
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { type: "speechSettingsLoaded", settings: { voiceEngine: "cascade-v1" } },
        }),
      )
      await tick()
      check(voice.startBlocked() === true, "invalid or missing saved state cannot release startup gate")
    }
  }
  console.log(`Speech settings handshake passed: ${mode} ${checks} assertions`)
} finally {
  dispose()
  await window.happyDOM.close()
}
