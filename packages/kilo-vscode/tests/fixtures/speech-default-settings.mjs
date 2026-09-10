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
try {
  await load()
  check(
    root.querySelector('[aria-label="Voice engine"]')?.textContent.includes("OpenAI Realtime"),
    "actual engine selector shows OpenAI by default",
  )
  check(root.textContent.includes("gpt-realtime-2.1"), "settings display the existing native model")
  check(root.textContent.includes("Add a key with access"), "missing dedicated key has actionable guidance")
  check(voice.settings().hasOpenAIKey === false, "empty storage reports no OpenAI secret")
  const input = root.querySelector('input[aria-label="OpenAI API key"]')
  assert.ok(input)
  input.value = "fixture-openai-secret"
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
  await tick()
  button("Save OpenAI API key").click()
  await tick()
  const save = sent.findLast((item) => item.type === "speechKeyUpdate")
  check(
    save?.kind === "openai" && save.key === "fixture-openai-secret",
    "actual Save routes only the dedicated OpenAI key",
  )
  await store.setKey(save.kind, save.key)
  await load()
  check(input.value === "", "submitted key draft is cleared")
  check(root.textContent.includes("An OpenAI key is stored"), "acknowledged key updates visible recovery state")
  check(
    !JSON.stringify(await store.load()).includes("fixture-openai-secret"),
    "public settings never contain secret bytes",
  )
  button("Clear OpenAI API key").click()
  await tick()
  const clear = sent.findLast((item) => item.type === "speechKeyUpdate")
  check(clear?.kind === "openai" && clear.key === undefined, "Clear targets only the OpenAI secret")
  await store.setKey(clear.kind, clear.key)
  await load()
  check(root.textContent.includes("Add a key with access"), "cleared key returns to setup guidance")
  await store.update({ voiceEngine: "qwen-realtime", mode: "off" })
  await load()
  check(
    root.querySelector('[aria-label="Voice engine"]')?.textContent.includes("Legacy Qwen"),
    "saved Qwen remains visibly selected",
  )
  check(
    !root.querySelector('input[aria-label="OpenAI API key"]'),
    "OpenAI setup is hidden for explicit legacy selection",
  )
  await store.update({ voiceEngine: "cascade-v1" })
  await load()
  check(
    root.querySelector('[aria-label="Voice engine"]')?.textContent.includes("cascade-v1"),
    "saved cascade remains visibly selected",
  )
  check(media === 0, "settings and key changes never request microphone capture")
  check(
    !sent.some((item) => ["speechOpenAIStart", "speechRealtimeStart"].includes(item.type)),
    "settings and key changes never admit a voice call",
  )
  console.log(`Speech default settings integration passed: ${checks} assertions`)
} finally {
  dispose()
  await window.happyDOM.close()
}
