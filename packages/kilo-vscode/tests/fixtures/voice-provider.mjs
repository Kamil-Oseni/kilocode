import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import { chromium } from "@playwright/test"

// Only surrounding host/session contexts are synthetic. VoiceProvider and its
// media, handoff, recovery and usage implementations are bundled unmodified.
const directory = await mkdtemp(join(tmpdir(), "raya-voice-provider-"))
const output = join(directory, "voice.js")
const adapter = {
  name: "surrounding-contexts",
  setup(build) {
    build.onResolve({ filter: /^\.\/(vscode|session)$/ }, (args) => {
      if (!args.importer.replaceAll("\\", "/").endsWith("context/voice.tsx")) return
      return { path: args.path, namespace: "fixture" }
    })
    build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
      contents:
        args.path === "./vscode"
          ? "export const useVSCode = () => window.fixture.host;"
          : "export const useSession = () => window.fixture.session;",
      loader: "js",
    }))
  },
}
await build({
  stdin: {
    contents: `import { createComponent } from "solid-js";
      import { render } from "solid-js/web";
      import { VoiceProvider, useVoice } from "./webview-ui/src/context/voice";
      export { DEFAULT_SPEECH_SETTINGS } from "./src/shared/speech";
      export function mount(node) {
        return render(() => createComponent(VoiceProvider, {
          get children() { return createComponent(() => { window.fixture.voice = useVoice(); return null; }, {}); }
        }), node);
      }`,
    resolveDir: resolve("."),
    sourcefile: "provider-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "Provider",
  plugins: [adapter, solidPlugin()],
})
const script = await readFile(output)
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/voice.js" ? "text/javascript" : "text/html")
  response.end(
    request.url === "/voice.js"
      ? script
      : '<!doctype html><title>Synthetic VoiceProvider boundary</title><main id="root"></main><script src="/voice.js"></script>',
  )
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] })
try {
  const page = await browser.newPage()
  page.on("console", (message) => console.log(message.text()))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const result = await page.evaluate(async () => {
    const checks = []
    const check = (value, label) => {
      if (!value) throw new Error(label)
      checks.push(label)
      console.log(`Verified: ${label}`)
    }
    const until = async (condition) => {
      const start = Date.now()
      while (!condition()) {
        if (Date.now() - start > 10_000)
          throw new Error(
            `Synthetic provider condition timed out: ${window.fixture.voice.status()} / ${window.fixture.voice.error()}`,
          )
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    const peers = []
    const locals = []
    const tracks = []
    const remotes = []
    const contexts = []
    const captures = []
    const handlers = new Set()
    const posts = []
    const stops = []
    const Native = window.RTCPeerConnection
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args)
        peers.push(this)
      }
      createDataChannel(label, options) {
        if (label === "oai-events") locals.push(this)
        return super.createDataChannel(label, options)
      }
      addTrack(track, ...streams) {
        if (locals.includes(this)) tracks.push(track)
        return super.addTrack(track, ...streams)
      }
    }
    const capture = () => {
      const context = new AudioContext()
      contexts.push(context)
      const destination = context.createMediaStreamDestination()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      gain.gain.value = 0
      oscillator.connect(gain).connect(destination)
      oscillator.start()
      return destination.stream
    }
    const original = navigator.mediaDevices.getUserMedia
    navigator.mediaDevices.getUserMedia = async () => {
      const stream = capture()
      captures.push(stream)
      return stream
    }
    const stopped = () =>
      locals.every((peer) => peer.connectionState === "closed") &&
      tracks.every((track) => track.readyState === "ended") &&
      captures.every((stream) => stream.getTracks().every((track) => track.readyState === "ended"))
    window.fixture = {
      session: { currentSessionID: () => "session-provider" },
      host: {
        postMessage(message) {
          posts.push(message)
          if (message.type === "speechOpenAIStop") stops.push({ id: message.requestId, closed: stopped() })
        },
        onMessage(handler) {
          handlers.add(handler)
          return () => handlers.delete(handler)
        },
      },
    }
    const send = (message) => handlers.forEach((handler) => handler(message))
    const find = (type, id) =>
      posts.findLast(
        (message) =>
          message.type === type &&
          (!id || message.handoff?.id === id || message.ack?.id === id || message.quiet?.id === id),
      )
    const exchange = async (sdp) => {
      const peer = new Native()
      remotes.push(peer)
      peer.ondatachannel = (event) => {
        event.channel.onmessage = () => {}
      }
      const stream = capture()
      peer.addTrack(stream.getAudioTracks()[0], stream)
      await peer.setRemoteDescription({ type: "offer", sdp })
      await peer.setLocalDescription(await peer.createAnswer())
      await until(() => peer.iceGatheringState === "complete")
      return peer.localDescription.sdp
    }
    const settings = {
      ...Provider.DEFAULT_SPEECH_SETTINGS,
      voiceEngine: "openai-realtime",
      hasOpenAIKey: true,
      hasRealtimeKey: false,
      hasSttKey: false,
      hasTtsKey: false,
    }
    const mount = () => {
      const dispose = Provider.mount(document.getElementById("root"))
      send({ type: "speechSettingsLoaded", settings })
      return dispose
    }
    const start = async () => {
      await until(() => !window.fixture.voice.startBlocked())
      const count = posts.filter((message) => message.type === "speechOpenAIStart").length
      window.fixture.voice.start("session-provider")
      await until(() => posts.filter((message) => message.type === "speechOpenAIStart").length > count)
      const offer = find("speechOpenAIStart")
      send({ type: "speechOpenAIReady", requestId: offer.requestId, sdp: await exchange(offer.sdp) })
      await until(() => window.fixture.voice.status() === "listening")
      return offer.requestId
    }
    const prepare = async (source, id) => {
      const handoff = { version: 1, id, sessionID: "session-provider", source, target: `${id}-target` }
      send({ type: "speechOpenAIHandoffPrepare", handoff })
      await until(() => find("speechOpenAIHandoffOffer", id))
      return handoff
    }
    const answer = async (handoff) => {
      const offer = find("speechOpenAIHandoffOffer", handoff.id)
      const sdp = await exchange(offer.sdp)
      send({ type: "speechOpenAIHandoffAnswer", handoff, sdp })
      await until(() => find("speechOpenAIHandoffPrepared", handoff.id))
      return sdp
    }
    let dispose = mount()
    try {
      const source = await start()
      const first = await prepare(source, "handoff-first")
      await answer(first)
      send({ type: "speechOpenAIHandoffQuiesce", handoff: first })
      const quiet = find("speechOpenAIHandoffQuiesced", first.id)?.quiet
      check(!!quiet, "actual provider publishes local quiescence")
      send({ type: "speechOpenAIHandoffCutover", quiet })
      check(!!find("speechOpenAIHandoffCutoverAck", first.id), "actual provider promotes first target")
      send({ type: "speechOpenAIHandoffRetire", handoff: first })
      check(find("speechOpenAIHandoffRetired", first.id)?.confirmed, "actual provider retires first source")
      const usage = {
        responses: 1,
        transcriptions: 0,
        input: 1,
        output: 2,
        missing: 0,
        invalid: 0,
        recorded: 1,
        unrecorded: 0,
        pending: 0,
        incomplete: false,
      }
      send({ type: "speechOpenAIUsage", requestId: source, sessionID: first.sessionID, usage })
      check(window.fixture.voice.usage()?.output === 2, "logical source usage remains accepted after promotion")
      const second = await prepare(first.target, "handoff-second")
      const count = stops.length
      send({ type: "speechOpenAIHandoffNotice", handoff: first, reason: "unavailable" })
      check(stops.length === count && !stopped(), "prior identity notice cannot terminate new handoff")
      send({ type: "speechOpenAIError", requestId: first.target, error: "Synthetic current transport failure" })
      check(
        stops.length === count + 1 && stops.at(-1).id === first.target && stops.at(-1).closed,
        "active target failure closes all local lanes before host Stop",
      )
      send({ type: "speechOpenAIHandoffAnswer", handoff: second, sdp: "late" })
      send({ type: "speechOpenAIHandoffCutover", quiet: { ...second, phase: "quiesced", epoch: 0 } })
      check(
        stopped() && !find("speechOpenAIHandoffCutoverAck", second.id),
        "late answer and cutover cannot revive failed provider",
      )
      send({ type: "speechOpenAIStopped", requestId: first.target })
      const next = await start()
      const pending = await prepare(next, "handoff-stop")
      window.fixture.voice.stop()
      check(
        stops.at(-1).closed && stops.at(-1).id === next,
        "manual Stop closes warming lanes before host notification",
      )
      send({ type: "speechOpenAIHandoffAnswer", handoff: pending, sdp: "late" })
      check(stopped(), "late preparation answer cannot revive manually stopped voice")
      send({ type: "speechOpenAIStopped", requestId: next })
      const last = await start()
      const reload = await prepare(last, "handoff-reload")
      dispose()
      check(
        stopped() && stops.at(-1).closed && handlers.size === 0,
        "provider disposal closes lanes and unsubscribes before reload",
      )
      dispose = mount()
      send({ type: "speechOpenAIHandoffAnswer", handoff: reload, sdp: "late" })
      send({ type: "speechOpenAIHandoffNotice", handoff: reload, reason: "unavailable" })
      send({ type: "speechOpenAIError", requestId: last, error: "old generation" })
      check(
        stopped() && window.fixture.voice.status() === "off",
        "reloaded provider ignores prior generation transport messages",
      )
      check(captures.length === 3, "handoff clones synthetic capture without microphone reacquisition")
    } finally {
      dispose()
      navigator.mediaDevices.getUserMedia = original
      window.RTCPeerConnection = Native
      for (const peer of [...peers, ...remotes]) peer.close()
      await Promise.all(contexts.map((context) => context.close()))
    }
    return checks
  })
  assert.equal(result.length, 12)
  console.log(`${result.length} actual VoiceProvider implementation assertions passed`)
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
