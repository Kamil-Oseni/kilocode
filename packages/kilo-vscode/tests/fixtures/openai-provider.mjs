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
const { createComponent, createSignal } = await import("solid-js")
const [current, setCurrent] = createSignal("session-a")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { VoiceProvider, useVoice } = await import("../../webview-ui/src/context/voice.tsx")
const { OpenAIVoice } = await import("../../webview-ui/src/context/openai-voice.ts")
const { RealtimeVoice } = await import("../../webview-ui/src/context/realtime-voice.ts")
const { StreamPlayer } = await import("../../webview-ui/src/context/stream-player.ts")
const { DEFAULT_SPEECH_SETTINGS } = await import("../../src/shared/speech.ts")
const starts = []
const clients = []
let stopped = 0
let legacy = 0
let played = 0
let checks = 0
const check = (value, label) => {
  assert.ok(value, label)
  checks++
}
// Substitute media boundaries only; provider state, bridge routing and admission are production.
OpenAIVoice.prototype.start = async function (input, exchange) {
  starts.push(input)
  clients.push(this)
  this.sink.status("connecting")
  await exchange("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n")
  this.sink.status("listening")
}
OpenAIVoice.prototype.stop = async function () {
  stopped++
  this.sink.status("off")
}
RealtimeVoice.prototype.start = async function () {
  legacy++
  this.sink.status("listening")
}
RealtimeVoice.prototype.stop = async function () {}
StreamPlayer.prototype.unlock = function () {}
StreamPlayer.prototype.push = function () {
  played++
}
StreamPlayer.prototype.stop = function () {}
StreamPlayer.prototype.reset = function () {}
let voice
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(SessionContext.Provider, {
          value: { currentSessionID: current },
          get children() {
            return createComponent(VoiceProvider, {
              get children() {
                voice = useVoice()
                return document.createElement("span")
              },
            })
          },
        })
      },
    }),
  root,
)
const send = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const count = (type) => sent.filter((item) => item.type === type).length
const state = (patch = {}) =>
  send({
    type: "speechSettingsLoaded",
    settings: {
      ...DEFAULT_SPEECH_SETTINGS,
      hasOpenAIKey: true,
      hasRealtimeKey: true,
      hasSttKey: true,
      hasTtsKey: true,
      sttEndpoint: "https://unused.invalid",
      ...patch,
    },
  })
const ready = (requestId) => send({ type: "speechOpenAIReady", requestId, sdp: "local-answer" })
try {
  check(voice.settings().voiceEngine === "openai-realtime", "unconfigured provider starts with the OpenAI default")
  check(starts.length === 0 && legacy === 0, "initial default never starts a media transport")
  state({ voiceEngine: "qwen-realtime", mode: "off" })
  await tick()
  check(voice.settings().voiceEngine === "qwen-realtime", "loaded explicit legacy selection replaces initial default")
  check(starts.length === 0 && legacy === 0, "loading a saved engine never starts recording")
  state({ hasOpenAIKey: false })
  voice.start("session-a")
  await tick()
  check(starts.length === 0, "missing key never enters microphone transport")
  check(count("speechOpenAIStart") === 0, "missing key never requests a provider call")
  check(voice.status() === "off" && /key/i.test(voice.error()), "missing key has actionable off state")
  state()
  voice.start("session-a")
  await tick()
  const first = sent.find((item) => item.type === "speechOpenAIStart")
  check(
    first?.sessionID === "session-a" && starts[0].requestID === first.requestId,
    "host request preserves native operation identity",
  )
  check(voice.status() === "connecting", "pending answer stays connecting")
  ready("unrelated")
  await tick()
  check(voice.status() === "connecting", "unrelated ready cannot resolve exchange")
  ready(first.requestId)
  await tick()
  check(voice.status() === "listening", "owned answer completes native start")
  voice.start("session-b")
  check(starts.length === 1 && voice.status() === "listening", "duplicate start preserves active state")
  clients[0].sink.notice("Transcript is incomplete")
  check(
    voice.error() === "Transcript is incomplete" && voice.status() === "listening",
    "nonfatal notice preserves audio",
  )
  send({ type: "speechOpenAIError", requestId: "unrelated", error: "wrong call" })
  check(voice.status() === "listening", "unrelated error cannot stop current call")
  send({ type: "speechRealtimeError", code: "failed", error: "old provider", fallback: "cascade-v1" })
  send({
    type: "speechRealtimeReady",
    connection: {
      id: "old",
      livekitURL: "ws://unused",
      clientToken: "unused",
      engine: "qwen-realtime",
      acceptsTruncation: false,
    },
  })
  send({ type: "speechPlaybackChunk", requestId: "old-playback", data: "AA==", mime: "audio/pcm" })
  await tick()
  check(legacy === 0 && played === 0 && !voice.cascade(), "stale legacy messages cannot switch provider or play audio")
  check(voice.status() === "listening", "legacy messages preserve native connection status")
  voice.stop()
  check(voice.status() === "off" && stopped > 0, "explicit stop closes local media")
  check(
    sent.some((item) => item.type === "speechOpenAIStop" && item.requestId === first.requestId),
    "stop carries owned host request",
  )
  ready(first.requestId)
  voice.start("session-a")
  await tick()
  check(starts.length === 1 && voice.status() === "off", "late ready and new start cannot bypass pending close")
  send({ type: "speechOpenAIStopped", requestId: "unrelated" })
  voice.start("session-a")
  check(starts.length === 1, "unrelated stop acknowledgment cannot release admission")
  send({ type: "speechOpenAIStopped", requestId: first.requestId })
  voice.start("session-a")
  await tick()
  const second = sent.filter((item) => item.type === "speechOpenAIStart").at(-1)
  check(starts.length === 2 && second.requestId !== first.requestId, "explicit retry after close gets new identity")
  ready(first.requestId)
  await tick()
  check(voice.status() === "connecting", "previous generation answer cannot start replacement")
  const before = stopped
  voice.update({ voiceEngine: "qwen-realtime" })
  await tick()
  check(stopped > before && voice.status() === "off", "local engine change closes native audio before host echo")
  check(
    sent.some((item) => item.type === "speechOpenAIStop" && item.requestId === second.requestId),
    "engine change closes the correct host call",
  )
  ready(second.requestId)
  send({
    type: "speechRealtimeReady",
    connection: {
      id: "stale-transition",
      livekitURL: "ws://unused",
      clientToken: "unused",
      engine: "qwen-realtime",
      acceptsTruncation: false,
    },
  })
  send({ type: "speechRealtimeError", code: "failed", error: "stale transition", fallback: "cascade-v1" })
  await tick()
  check(voice.status() === "off" && legacy === 0, "engine change never automatically starts replacement provider")
  send({ type: "speechOpenAIStopped", requestId: second.requestId })
  state()
  voice.start("session-a")
  await tick()
  const third = sent.filter((item) => item.type === "speechOpenAIStart").at(-1)
  send({ type: "speechOpenAIError", requestId: third.requestId, error: "OpenAI setup was rejected" })
  await tick()
  check(voice.status() === "degraded" && !voice.cascade(), "owned failure is visible without provider fallback")
  check(
    sent.some((item) => item.type === "speechOpenAIStop" && item.requestId === third.requestId),
    "owned failure requests host cleanup",
  )
  ready(third.requestId)
  await tick()
  check(voice.status() === "degraded", "late answer cannot resurrect failed call")
  send({ type: "speechOpenAIStopped", requestId: third.requestId })
  state()
  voice.start("session-a")
  await tick()
  const fourth = sent.filter((item) => item.type === "speechOpenAIStart").at(-1)
  ready(fourth.requestId)
  await tick()
  state({ voiceEngine: "qwen-realtime" })
  await tick()
  check(voice.status() === "off" && legacy === 0, "host engine change also stops without automatic replacement")
  send({ type: "speechOpenAIStopped", requestId: fourth.requestId })
  state()
  voice.start("session-a")
  await tick()
  const fifth = sent.filter((item) => item.type === "speechOpenAIStart").at(-1)
  ready(fifth.requestId)
  await tick()
  clients.at(-1).sink.transcript({
    type: "response.output_audio_transcript.done",
    item: "old-parent",
    text: "Old task transcript",
    stable: true,
  })
  check(voice.transcript()?.text === "Old task transcript", "owned transcript displayed before navigation")
  setCurrent("session-b")
  await tick()
  check(
    voice.status() === "off" && voice.transcript() === undefined,
    "navigation stops media and clears old task transcript",
  )
  check(
    sent.some((item) => item.type === "speechOpenAIStop" && item.requestId === fifth.requestId),
    "navigation closes original parent call",
  )
  ready(fifth.requestId)
  clients.at(-1).sink.transcript({
    type: "response.output_audio_transcript.done",
    item: "late-parent",
    text: "Late old task transcript",
    stable: true,
  })
  await tick()
  check(
    voice.transcript() === undefined && voice.status() === "off",
    "late old-parent transcript cannot appear in new task",
  )
  console.log(`OpenAI provider integration passed: ${checks} assertions; no microphone or provider connection.`)
} finally {
  dispose()
  await tick()
  window.happyDOM.abort()
}
