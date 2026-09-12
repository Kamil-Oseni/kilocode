import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join, dirname, basename } from "node:path"
import { build } from "esbuild"
import { chromium } from "@playwright/test"

const directory = await mkdtemp(join(tmpdir(), "raya-live-voice-"))
const output = join(directory, "voice.js")
await build({
  entryPoints: [resolve("webview-ui/src/context/live-voice.ts")],
  outfile: output,
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "Voice",
})
console.log("Live fixture: production transport built")
const script = await readFile(output)
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/voice.js" ? "text/javascript" : "text/html")
  response.end(
    request.url === "/voice.js"
      ? script
      : '<!doctype html><title>Live voice transport fixture</title><button id="start">Start local test</button><script src="/voice.js"></script>',
  )
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] })
try {
  console.log("Live fixture: Chromium launched")
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
        if (Date.now() - start > 10_000) throw new Error("Local peer condition timed out")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    const captures = []
    const peers = []
    const contexts = []
    const exchanges = []
    const events = { statuses: [], captions: [], errors: [], aec: [] }
    const sink = {
      status: (value) => events.statuses.push(value),
      captions: (value) => events.captions.push(value),
      error: (value) => events.errors.push(value),
      aec: (value) => events.aec.push(value),
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
      captures.push(destination.stream)
      return destination.stream
    }
    const requests = []
    const original = navigator.mediaDevices.getUserMedia
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      requests.push(constraints)
      return capture()
    }
    const originalChannel = RTCPeerConnection.prototype.createDataChannel
    let local
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      local = originalChannel.apply(this, args)
      return local
    }
    const inbound = []
    let channel
    const negotiate = async (sdp) => {
      const peer = new RTCPeerConnection()
      peers.push(peer)
      peer.ondatachannel = (event) => {
        channel = event.channel
        channel.addEventListener("message", (message) => inbound.push(message.data))
      }
      const stream = capture()
      peer.addTrack(stream.getAudioTracks()[0], stream)
      await peer.setRemoteDescription({ type: "offer", sdp })
      await peer.setLocalDescription(await peer.createAnswer())
      const start = Date.now()
      while (peer.iceGatheringState !== "complete" && Date.now() - start < 2000)
        await new Promise((resolve) => setTimeout(resolve, 10))
      if (!peer.localDescription?.sdp) throw new Error("No local Live voice answer")
      return peer.localDescription.sdp
    }
    const voice = new Voice.LiveVoice(sink)
    const drop = () => {
      for (const peer of peers) peer.close()
      peers.length = 0
      channel = undefined
      for (const context of contexts) void context.close()
      contexts.length = 0
    }
    const finish = async (id) => {
      const closing = voice.stop()
      voice.finalized(id)
      await closing
      drop()
    }
    try {
      await voice.start({ sessionID: "", requestID: "request-a" }, negotiate).then(
        () => {
          throw new Error("unowned start admitted")
        },
        () => check(exchanges.length === 0, "unowned start rejected without exchange"),
      )

      const early = async (sdp) => {
        exchanges.push(sdp)
        const track = captures[0].getAudioTracks()[0]
        check(
          events.statuses.at(-1) === "connecting" && track.readyState === "live" && !track.enabled,
          "microphone stays disabled after capture and before host start",
        )
        check(voice.mute(false) && !track.enabled, "unmute before local readiness cannot enable capture")
        voice.started("request-a")
        check(!track.enabled, "host start before SDP still leaves capture disabled")
        return negotiate(sdp)
      }
      await voice.start({ sessionID: "session-a", requestID: "request-a" }, early)
      const live = captures[0].getAudioTracks()[0]
      check(events.statuses.at(-1) === "listening", "native peer, channel and host start establish listening")
      check(exchanges.length === 1, "one host exchange")
      check(live.enabled && live.readyState === "live", "capture enables only after host start and local peer readiness")
      check(
        requests[0]?.audio?.echoCancellation === true &&
          requests[0]?.audio?.noiseSuppression === true &&
          requests[0]?.audio?.autoGainControl === true,
        "webview capture requests acoustic echo cancellation, noise suppression and automatic gain",
      )
      check(events.aec.at(-1) === false, "synthetic stream does not claim acoustic echo cancellation")
      check(inbound.length === 0, "listening establishes without client data-channel writes")
      check(
        voice.mute(true) && !live.enabled && live.readyState === "live",
        "mute keeps owned microphone live but disables its audio",
      )
      check(voice.mute(false) && live.enabled, "unmute resumes the same owned microphone")
      check(voice.silence(true) && voice.silence(false), "local output silence is accepted on an active call")
      await voice.start({ sessionID: "session-b", requestID: "request-b" }, negotiate).then(
        () => {
          throw new Error("duplicate start admitted")
        },
        () => check(exchanges.length === 1, "duplicate start rejected without exchange"),
      )

      await until(() => channel?.readyState === "open")
      channel.send(
        JSON.stringify({
          type: "session.input_transcript.delta",
          event_id: "user-1",
          delta: "Review the report",
          start_ms: 0,
          end_ms: 400,
        }),
      )
      await until(() => events.captions.at(-1)?.fragments.some((fragment) => fragment.text === "Review the report"))
      channel.send(
        JSON.stringify({
          type: "session.output_transcript.delta",
          event_id: "asst-1",
          delta: "Opening the file",
          start_ms: 400,
          end_ms: 900,
        }),
      )
      await until(() => events.captions.at(-1)?.fragments.some((fragment) => fragment.text === "Opening the file"))
      check(
        events.captions.at(-1).fragments.length === 2 && inbound.length === 0,
        "captions are display-only and never send client commands",
      )
      voice.silence(true)
      channel.send(
        JSON.stringify({
          type: "session.delegation.created",
          event_id: "del-1",
          offset_ms: 900,
          delegation: { id: "dlg_1", type: "delegation", target: "client" },
        }),
      )
      await until(() => events.captions.at(-1)?.fragments.length === 2)
      check(voice.silence(true) && inbound.length === 0, "caption and delegation events cannot write the data channel")
      local.onmessage(new MessageEvent("message", { data: "x".repeat(524_289) }))
      await until(() => events.errors.at(-1) === "Live voice received an oversized event. Reconnect to continue.")
      check(true, "oversized event fails the live transport")
      check(!live.enabled, "oversized event disables capture")

      const closing = voice.stop()
      check(!live.enabled && live.readyState === "live", "stop silences capture immediately without ending the track")
      check(!voice.mute(true) && !voice.silence(true), "closed media controls cannot revive ended voice")
      voice.finalized("request-other")
      await new Promise((resolve) => setTimeout(resolve, 50))
      check(live.readyState === "live", "wrong-request finalization cannot release the active call")
      voice.finalized("request-a")
      await closing
      check(events.statuses.at(-1) === "off", "host finalization reports off")
      check(
        captures[0].getTracks().every((track) => track.readyState === "ended"),
        "microphone track ended after host finalization",
      )
      voice.started("request-a")
      check(events.statuses.at(-1) === "off" && !voice.mute(false), "host start after disconnect cannot revive media")
      await until(() => channel.readyState === "closed")
      check(true, "real event channel closed")
      drop()

      let answer
      const pending = voice
        .start({ sessionID: "session-a", requestID: "request-late" }, async (sdp) => {
          exchanges.push(sdp)
          return new Promise((resolve) => {
            answer = resolve
          })
        })
        .then(
          () => "resolved",
          () => "cancelled",
        )
      await until(() => !!answer)
      const lateTrack = captures[2].getAudioTracks()[0]
      check(!lateTrack.enabled, "capture stays disabled during a pending SDP exchange")
      const late = voice.stop()
      check((await pending) === "cancelled", "stop settles pending exchange immediately")
      const before = events.statuses.length
      answer("late-invalid-answer")
      await new Promise((resolve) => setTimeout(resolve, 30))
      check(events.statuses.length === before, "late answer cannot revive stopped transport")
      voice.finalized("request-late")
      await late
      drop()
      check(
        captures[2].getTracks().every((track) => track.readyState === "ended"),
        "pending exchange releases its capture",
      )

      let microphone
      navigator.mediaDevices.getUserMedia = () =>
        new Promise((resolve) => {
          microphone = resolve
        })
      const acquiring = voice.start({ sessionID: "session-a", requestID: "request-mic" }, negotiate).then(
        () => "resolved",
        () => "cancelled",
      )
      const mic = voice.stop()
      check((await acquiring) === "cancelled", "stop settles pending microphone permission")
      const stream = capture()
      microphone(stream)
      await until(() => stream.getTracks().every((track) => track.readyState === "ended"))
      voice.finalized("request-mic")
      await mic
      drop()
      check(exchanges.length === 2, "late capture stopped without creating a call")

      navigator.mediaDevices.getUserMedia = async () => capture()
      const after = async (sdp) => {
        exchanges.push(sdp)
        return negotiate(sdp)
      }
      const later = voice.start({ sessionID: "session-a", requestID: "request-after" }, after)
      await until(() => channel?.readyState === "open")
      const waiting = captures.at(-2).getAudioTracks()[0]
      check(
        events.statuses.at(-1) === "connecting" && !waiting.enabled,
        "local answer and channel still leave capture off without host start",
      )
      voice.started("request-stale")
      await new Promise((resolve) => setTimeout(resolve, 40))
      check(!waiting.enabled && events.statuses.at(-1) === "connecting", "old request ID cannot enable capture")
      voice.started("request-after")
      await later
      check(events.statuses.at(-1) === "listening" && waiting.enabled, "host start after local readiness enables capture")

      await until(() => channel?.readyState === "open")
      const prior = events.errors.length
      channel.send("{")
      await until(() => events.errors.length === prior + 1)
      check(events.errors.length === prior + 1 && !waiting.enabled, "unreadable event fails once and disables capture")
      channel.send("{")
      await new Promise((resolve) => setTimeout(resolve, 30))
      check(events.errors.length === prior + 1, "repeated unreadable events do not accumulate errors")
      await finish("request-after")

      await voice
        .start({ sessionID: "session-a", requestID: "request-failed" }, async () => {
          throw new Error("host rejected")
        })
        .then(
          () => {
            throw new Error("failed exchange succeeded")
          },
          () => check(events.statuses.at(-1) === "degraded", "host failure is visible, no fallback"),
        )
      check(
        captures
          .at(-1)
          .getTracks()
          .every((track) => track.readyState === "ended"),
        "failed setup releases microphone",
      )
      await voice.stop()

      const linger = new Voice.LiveVoice(sink, 50)
      const held = linger.start({ sessionID: "session-a", requestID: "request-linger" }, after)
      await until(() => channel?.readyState === "open")
      linger.started("request-linger")
      await held
      const lingerClose = linger.stop()
      const track = captures.at(-2).getAudioTracks()[0]
      check(track.readyState === "live" && !track.enabled, "linger stop silences capture before host finalization")
      check(events.statuses.at(-1) === "listening", "linger wait retains local media until timeout")
      await lingerClose
      check(
        events.statuses.at(-1) === "off" && captures.at(-2).getTracks().every((item) => item.readyState === "ended"),
        "linger timeout releases media without a host finalized event",
      )

      drop()
      navigator.mediaDevices.getUserMedia = async () => {
        const err = new Error("Permission denied")
        err.name = "NotAllowedError"
        throw err
      }
      const fallback = new Voice.LiveVoice(sink, 50, async () => capture())
      const heldFallback = fallback.start({ sessionID: "session-a", requestID: "request-host" }, after)
      await until(() => channel?.readyState === "open")
      fallback.started("request-host")
      await heldFallback
      check(events.statuses.at(-1) === "listening", "denied webview microphone falls back to the host stream")
      check(captures.at(-2).getAudioTracks()[0].readyState === "live", "host fallback supplies a live track")
      const closingFallback = fallback.stop()
      fallback.finalized("request-host")
      await closingFallback
      drop()

      const pcm = Voice.pump(24000)
      check(pcm.stream.getAudioTracks()[0].readyState === "live", "PCM pump exposes a live MediaStreamTrack")
      pcm.write(new Int16Array(480).buffer)
      await pcm.close()
      check(
        pcm.stream.getTracks().every((item) => item.readyState === "ended"),
        "PCM pump close ends the host track",
      )

      return checks
    } finally {
      await voice.stop()
      navigator.mediaDevices.getUserMedia = original
      RTCPeerConnection.prototype.createDataChannel = originalChannel
      for (const peer of peers) peer.close()
      for (const stream of captures) for (const track of stream.getTracks()) track.stop()
      for (const context of contexts) await context.close()
    }
  })
  assert.equal(result.length, 45)
  console.log(`Live native WebRTC: ${result.length} implementation assertions passed; local peers/synthetic audio only.`)
} finally {
  await browser.close()
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  assert.equal(dirname(directory), resolve(tmpdir()))
  assert.ok(basename(directory).startsWith("raya-live-voice-"))
  await rm(directory, { recursive: true, force: true })
}
