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
  sttEndpoint: "http://127.0.0.1:8770/v1/audio/transcriptions",
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
const { voiceFallback } = await import("../../src/speech/fallback.ts")
let listens = 0
window.addEventListener("rayaVoiceListen", () => listens++)
try {
  await load()
  const settings = await store.load()
  check(settings.hasLocalKey === true && settings.hasTtsKey === false, "only the actual local key is present")
  check(voiceFallback(settings) === "cascade-v1", "actual local settings permit cascade")
  window.dispatchEvent(
    new window.MessageEvent("message", {
      data: {
        type: "speechRealtimeError",
        code: "configuration",
        error: "Native realtime disabled",
        fallback: voiceFallback(settings),
      },
    }),
  )
  await tick()
  check(voice.cascade() === true && listens > 0, "actual provider starts local cascade fallback")
  check(
    sent.some((row) => row.type === "speechSettingsUpdate" && row.settings.mode === "hands-free"),
    "cascade uses the real settings update route",
  )
  check(media === 0 && audio === 0, "policy transition neither captures nor plays audio")
  const count = listens
  voice.stop()
  await store.setKey("local", "")
  await store.setKey("tts", "synthetic-minimax-key-123456")
  await load()
  const missing = await store.load()
  check(missing.hasTtsKey === true && missing.hasLocalKey === false, "unselected cloud credential remains present")
  check(voiceFallback(missing) === "text", "cloud credential cannot authorize the local engine")
  window.dispatchEvent(
    new window.MessageEvent("message", {
      data: {
        type: "speechRealtimeError",
        code: "configuration",
        error: "Local key unavailable",
        fallback: voiceFallback(missing),
      },
    }),
  )
  await tick()
  check(listens === count, "missing selected credential cannot start another listen")
  console.log(`Speech local fallback passed: ${checks} assertions`)
} finally {
  dispose()
  await window.happyDOM.close()
}
