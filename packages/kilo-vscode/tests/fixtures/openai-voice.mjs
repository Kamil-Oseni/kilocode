import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join, dirname, basename } from "node:path"
import { build } from "esbuild"
import { chromium } from "@playwright/test"

const directory = await mkdtemp(join(tmpdir(), "raya-openai-voice-"))
const output = join(directory, "voice.js")
await build({
  entryPoints: [resolve("webview-ui/src/context/openai-voice.ts")],
  outfile: output,
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "Voice",
})
console.log("OpenAI fixture: production transport built")
const script = await readFile(output)
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/voice.js" ? "text/javascript" : "text/html")
  response.end(
    request.url === "/voice.js"
      ? script
      : '<!doctype html><title>Local voice transport fixture</title><button id="start">Start local test</button><script src="/voice.js"></script>',
  )
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] })
try {
  console.log("OpenAI fixture: Chromium launched")
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
    const events = { statuses: [], transcripts: [], errors: [], notices: [], aec: [] }
    const sink = {
      status: (value) => events.statuses.push(value),
      transcript: (value) => events.transcripts.push(value),
      error: (value) => events.errors.push(value),
      notice: (value) => events.notices.push(value),
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
    const original = navigator.mediaDevices.getUserMedia
    navigator.mediaDevices.getUserMedia = async () => capture()
    let channel
    const exchange = async (sdp) => {
      exchanges.push(sdp)
      const peer = new RTCPeerConnection()
      peers.push(peer)
      peer.ondatachannel = (event) => {
        channel = event.channel
      }
      const stream = capture()
      peer.addTrack(stream.getAudioTracks()[0], stream)
      await peer.setRemoteDescription({ type: "offer", sdp })
      await peer.setLocalDescription(await peer.createAnswer())
      await until(() => peer.iceGatheringState === "complete")
      return peer.localDescription.sdp
    }
    const voice = new Voice.OpenAIVoice(sink)
    try {
      await voice.start({ sessionID: "session-a", requestID: "request-a" }, exchange)
      check(events.statuses.at(-1) === "listening", "native peer and data channel establish listening")
      check(exchanges.length === 1, "one host exchange")
      check(
        voice.mute(true) &&
          !captures[0].getAudioTracks()[0].enabled &&
          captures[0].getAudioTracks()[0].readyState === "live",
        "mute keeps owned microphone live but disables its audio",
      )
      check(voice.mute(false) && captures[0].getAudioTracks()[0].enabled, "unmute resumes the same owned microphone")
      check(events.aec.at(-1) === false, "synthetic stream does not claim acoustic echo cancellation")
      await voice.start({ sessionID: "session-b", requestID: "request-b" }, exchange).then(
        () => {
          throw new Error("duplicate start admitted")
        },
        () => check(exchanges.length === 1, "duplicate start rejected without exchange"),
      )
      await until(() => channel?.readyState === "open")
      const send = (packet) =>
        channel.send(
          JSON.stringify({
            ...(packet.type.startsWith("response.output_audio_transcript")
              ? { response_id: "generated_response" }
              : {}),
            ...packet,
          }),
        )
      send({ type: "output_audio_buffer.started", response_id: "response_speech" })
      await until(() => events.statuses.at(-1) === "speaking")
      send({ type: "input_audio_buffer.speech_started" })
      await until(() => events.statuses.at(-1) === "listening")
      check(true, "native buffer and VAD events project speaking/interruption")
      send({ type: "output_audio_buffer.started", response_id: "response_speech" })
      await until(() => events.statuses.at(-1) === "speaking")
      const action = voice.interrupt()
      check(
        action?.responseID === "response_speech" && !!action.eventID && voice.operation.audio.muted,
        "stop speaking silences only the owned utterance and returns correlated host control",
      )
      check(
        voice.interrupt() === undefined &&
          channel.readyState === "open" &&
          captures[0].getAudioTracks()[0].readyState === "live",
        "repeated speech stop does not close voice or microphone",
      )
      send({ type: "error", error: { code: "response_cancel_not_active", event_id: action.eventID } })
      send({ type: "output_audio_buffer.started", response_id: "response_later" })
      send({ type: "output_audio_buffer.started" })
      send({ type: "conversation.item.input_audio_transcription.completed", item_id: "barrier", transcript: "barrier" })
      await until(() => events.transcripts.at(-1)?.item === "barrier")
      check(
        events.errors.length === 0 && voice.operation.audio.muted,
        "cancellation race is nonfatal and later or malformed events cannot unmute before clearance",
      )
      send({ type: "output_audio_buffer.cleared", response_id: "response_speech" })
      await until(() => events.statuses.at(-1) === "speaking")
      check(!voice.operation.audio.muted, "confirmed clearance allows later work-result speech without stopping work")
      events.transcripts.length = 0
      send({
        type: "response.output_audio_transcript.delta",
        item_id: "assistant",
        event_id: "delta1",
        delta: "Hello ",
      })
      send({
        type: "response.output_audio_transcript.delta",
        item_id: "assistant",
        event_id: "delta1",
        delta: "Hello ",
      })
      send({ type: "response.output_audio_transcript.delta", item_id: "assistant", event_id: "delta2", delta: "there" })
      send({ type: "response.output_audio_transcript.done", item_id: "assistant", transcript: "Hello there" })
      send({ type: "response.output_audio_transcript.delta", item_id: "assistant", delta: " late" })
      send({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "user",
        transcript: "Review the report",
      })
      send({ type: "response.function_call_arguments.done", item_id: "tool", arguments: '{"command":"execute"}' })
      send({ type: "__proto__", item_id: "bad", delta: "invalid" })
      send({ type: "response.output_audio_transcript.done", item_id: "large", transcript: "x".repeat(20_000) })
      await until(() => events.transcripts.at(-1)?.item === "large")
      check(events.transcripts.length === 5, "duplicates, late deltas and function calls excluded")
      check(events.transcripts[1].text === "Hello there", "delta accumulation")
      check(events.transcripts[2].stable === true, "completed transcript marked stable")
      check(
        events.transcripts[3].type === "conversation.item.input_audio_transcription.completed",
        "input transcript retained separately",
      )
      check(
        events.transcripts[4].text.length === 8192 && events.transcripts[4].truncated,
        "display transcript bounded explicitly",
      )
      send({
        type: "response.output_audio_transcript.done",
        response_id: "interrupt_response",
        item_id: "interrupted",
        transcript: "Never claim these words were heard",
      })
      send({ type: "output_audio_buffer.started", response_id: "interrupt_response" })
      await until(() => events.transcripts.at(-1)?.item === "interrupted")
      voice.interrupt()
      check(
        events.transcripts.at(-1)?.interruption === "pending" && events.transcripts.at(-1)?.text === "",
        "local interruption immediately hides generated words",
      )
      send({ type: "conversation.item.truncated", item_id: "interrupted", content_index: 0, audio_end_ms: 1250 })
      await until(() => events.transcripts.at(-1)?.interruption === "confirmed")
      check(
        events.transcripts.at(-1)?.audioEndMs === 1250 && events.transcripts.at(-1)?.text === "",
        "provider truncation confirms offset without inventing heard words",
      )
      send({ type: "output_audio_buffer.cleared", response_id: "interrupt_response" })
      send({
        type: "response.output_audio_transcript.done",
        response_id: "interrupt_response",
        item_id: "interrupted",
        transcript: "late unheard final",
      })
      send({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "new_input",
        transcript: "new input",
      })
      await until(() => events.transcripts.at(-1)?.item === "new_input")
      const count = events.transcripts.length
      send({ type: "conversation.item.truncated", item_id: "interrupted", content_index: 0, audio_end_ms: 1000 })
      send({
        type: "response.output_audio_transcript.done",
        response_id: "vad_response",
        item_id: "vad",
        transcript: "generated ahead of playback",
      })
      send({ type: "output_audio_buffer.started", response_id: "vad_response" })
      send({ type: "input_audio_buffer.speech_started" })
      await until(
        () => events.transcripts.at(-1)?.item === "vad" && events.transcripts.at(-1)?.interruption === "pending",
      )
      check(
        events.transcripts.length === count + 2,
        "old confirmation cannot replace newer input and VAD hides current generated output",
      )
      check(
        channel.readyState === "open" && captures[0].getAudioTracks()[0].readyState === "live",
        "transcript reconciliation preserves active native media",
      )
      check(voice.image("selected"), "image error registration belongs to the live native call")
      send({ type: "error", error: { code: "invalid_image", event_id: "image_selected" } })
      send({ type: "conversation.item.input_audio_transcription.failed", item_id: "missing" })
      await until(() => events.notices.length === 1)
      check(
        events.errors.length === 0 &&
          channel.readyState === "open" &&
          captures[0].getAudioTracks()[0].readyState === "live",
        "transcript failure is nonfatal and preserves native audio",
      )
      await voice.stop()
      check(events.statuses.at(-1) === "off", "explicit stop reports off")
      check(!voice.mute(true) && voice.interrupt() === undefined, "inactive media controls cannot revive ended voice")
      check(
        captures[0].getTracks().every((track) => track.readyState === "ended"),
        "microphone track ended",
      )
      await until(() => channel.readyState === "closed")
      check(true, "real event channel closed")

      let answer
      const pending = voice
        .start({ sessionID: "session-a", requestID: "request-late" }, async () => {
          exchanges.push("held")
          return new Promise((resolve) => {
            answer = resolve
          })
        })
        .then(
          () => "resolved",
          () => "cancelled",
        )
      await until(() => !!answer)
      await voice.stop()
      check((await pending) === "cancelled", "stop settles pending exchange immediately")
      const before = events.statuses.length
      answer("late-invalid-answer")
      await new Promise((resolve) => setTimeout(resolve, 30))
      check(events.statuses.length === before, "late answer cannot revive stopped transport")
      check(
        captures[2].getTracks().every((track) => track.readyState === "ended"),
        "pending exchange releases its capture",
      )

      let microphone
      navigator.mediaDevices.getUserMedia = () =>
        new Promise((resolve) => {
          microphone = resolve
        })
      const acquiring = voice.start({ sessionID: "session-a", requestID: "request-mic" }, exchange).then(
        () => "resolved",
        () => "cancelled",
      )
      await voice.stop()
      check((await acquiring) === "cancelled", "stop settles pending microphone permission")
      const stream = capture()
      microphone(stream)
      await until(() => stream.getTracks().every((track) => track.readyState === "ended"))
      check(exchanges.length === 2, "late capture stopped without creating a call")

      navigator.mediaDevices.getUserMedia = async () => capture()
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
      check(events.errors.length === 1, "one inspectable transport failure")
      await voice.stop()
      await voice.start({ sessionID: "session-a", requestID: "request-error" }, exchange)
      await until(() => channel?.readyState === "open")
      send({ type: "error", error: { code: "response_cancel_not_active", event_id: "unrelated" } })
      await until(() => events.errors.length === 2)
      check(
        events.statuses.at(-1) === "degraded",
        "unrelated cancellation errors remain fatal instead of being broadly ignored",
      )
      await voice.stop()
      return checks
    } finally {
      await voice.stop()
      navigator.mediaDevices.getUserMedia = original
      for (const peer of peers) peer.close()
      for (const stream of captures) for (const track of stream.getTracks()) track.stop()
      for (const context of contexts) await context.close()
    }
  })
  assert.equal(result.length, 35)
  console.log(
    `OpenAI native WebRTC: ${result.length} implementation assertions passed; local peers/synthetic audio only.`,
  )
} finally {
  await browser.close()
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  assert.equal(dirname(directory), resolve(tmpdir()))
  assert.ok(basename(directory).startsWith("raya-openai-voice-"))
  await rm(directory, { recursive: true, force: true })
}
