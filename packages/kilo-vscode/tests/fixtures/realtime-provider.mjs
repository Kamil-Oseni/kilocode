import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-view-dom",
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
const { VoiceProvider, useVoice } = await import("../../webview-ui/src/context/voice.tsx")
const { RealtimeVoice } = await import("../../webview-ui/src/context/realtime-voice.ts")
const failures = []
let cleanup = 0
// Drive only the transport boundary; all message routing and reactive state is production VoiceProvider.
RealtimeVoice.prototype.start = function () {
  this.sink.status("listening")
  return new Promise((_, reject) => failures.push(reject))
}
RealtimeVoice.prototype.stop = async function () {
  cleanup++
}
let voice
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(VoiceProvider, {
          get children() {
            voice = useVoice()
            return document.createElement("span")
          },
        })
      },
    }),
  root,
)
const send = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))
const ready = (id) =>
  send({
    type: "speechRealtimeReady",
    connection: {
      id,
      livekitURL: "ws://unused",
      clientToken: "synthetic",
      engine: "qwen-realtime",
      acceptsTruncation: false,
    },
  })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
try {
  ready("old")
  ready("new")
  failures[0](new Error("old secret transport error"))
  await tick()
  assert.equal(voice.status(), "listening")
  assert.equal(cleanup, 0)
  assert.equal(sent.filter((item) => item.type === "speechRealtimeStop").length, 0)
  send({ type: "speechRealtimeError", code: "busy", error: "Already owned" })
  assert.equal(voice.status(), "listening")
  failures[1](new Error("new secret transport error"))
  await tick()
  assert.equal(cleanup, 1)
  assert.equal(voice.status(), "degraded")
  assert.equal(voice.cascade(), false)
  assert.equal(sent.filter((item) => item.type === "speechRealtimeStop").length, 1)
  assert.ok(!voice.error().includes("secret"))
  send({ type: "speechRealtimeStopped" })
  assert.equal(voice.status(), "degraded")
  voice.stop()
  send({ type: "speechRealtimeStopped" })
  assert.equal(voice.status(), "off")
  console.log("Voice provider lifecycle assertions passed")
} finally {
  dispose()
  await tick()
  window.happyDOM.abort()
}
