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
  stdin: {
    contents:
      'export { OpenAIVoice } from "./webview-ui/src/context/openai-voice"; export { createHandoff } from "./webview-ui/src/context/voice-handoff"; export { createVoiceRecovery } from "./webview-ui/src/context/voice-recovery"; export { createRoot } from "solid-js";',
    resolveDir: resolve("."),
    sourcefile: "voice-entry.ts",
    loader: "ts",
  },
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
    const refuses = (action) => {
      try {
        action()
        return false
      } catch (error) {
        if (!(error instanceof Error)) throw error
        return true
      }
    }
    const until = async (condition) => {
      const start = Date.now()
      while (!condition()) {
        if (Date.now() - start > 10_000) throw new Error("Local peer condition timed out")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    const captures = []
    const gains = []
    const peers = []
    const meters = new Map()
    const channels = new Map()
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
      gains.push(gain)
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
      peer.ontrack = (event) => {
        const context = new AudioContext()
        contexts.push(context)
        const meter = context.createAnalyser()
        meter.fftSize = 256
        context.createMediaStreamSource(event.streams[0] ?? new MediaStream([event.track])).connect(meter)
        meters.set(peer, meter)
        void context.resume()
      }
      peer.ondatachannel = (event) => {
        channel = event.channel
        channels.set(peer, event.channel)
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

      await voice.start({ sessionID: "session-warm", requestID: "source-warm" }, exchange)
      const source = voice.operation
      const sourcepeer = peers.at(-1)
      gains[captures.indexOf(source.media)].gain.value = 0.1
      await Promise.all(contexts.map((context) => context.resume()))
      const signal = (peer) => {
        const meter = meters.get(peer)
        if (!meter) return false
        const samples = new Float32Array(meter.fftSize)
        meter.getFloatTimeDomainData(samples)
        return samples.some((sample) => Math.abs(sample) > 0.005)
      }
      await until(() => signal(sourcepeer))
      await until(() => channels.get(sourcepeer)?.readyState === "open")
      const sourcechannel = channels.get(sourcepeer)
      const handoff = {
        version: 1,
        id: "handoff-warm",
        sessionID: "session-warm",
        source: "source-warm",
        target: "target-warm",
      }
      const beforeprepare = captures.length
      const statuses = events.statuses.length
      const prepared = await voice.prepare(handoff, exchange)
      const candidate = voice.candidate
      const candidatepeer = peers.at(-1)
      await until(() => channels.get(candidatepeer)?.readyState === "open")
      const candidatechannel = channels.get(candidatepeer)
      check(
        prepared.phase === "prepared" &&
          prepared.id === handoff.id &&
          prepared.sessionID === handoff.sessionID &&
          Object.isFrozen(prepared),
        "prepared receipt owns the entire immutable handoff identity",
      )
      check(
        voice.operation === source && source.media.getAudioTracks()[0].enabled && sourcechannel.readyState === "open",
        "source remains serving while candidate is prepared",
      )
      check(
        captures.length === beforeprepare + 1 &&
          candidate.media.getAudioTracks()[0] !== source.media.getAudioTracks()[0] &&
          !candidate.media.getAudioTracks()[0].enabled,
        "preparation clones microphone without reacquiring and keeps candidate input disabled",
      )
      check(
        candidate.audio.muted && candidate.playback && events.statuses.length === statuses,
        "candidate playback is admitted silently without changing visible status",
      )
      await until(() => meters.has(candidatepeer))
      await new Promise((resolve) => setTimeout(resolve, 150))
      check(
        signal(sourcepeer) && !signal(candidatepeer),
        "real loopback source carries signal while prepared candidate carries silence",
      )
      await voice.prepare({ ...handoff, id: "other", target: "other-target" }, exchange).then(
        () => {
          throw new Error("second candidate admitted")
        },
        () => check(voice.candidate === candidate, "second candidate refuses without replacing prepared media"),
      )
      candidatechannel.send(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "hidden",
          transcript: "candidate text must stay hidden",
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 30))
      check(
        !events.transcripts.some((item) => item.text === "candidate text must stay hidden"),
        "candidate transcript never projects before cutover",
      )
      check(
        refuses(() => voice.cutover({ ...handoff, id: "wrong" })) &&
          voice.operation === source &&
          source.media.getAudioTracks()[0].enabled,
        "changed handoff identity refuses without touching source",
      )
      sourcechannel.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }))
      await until(() => source.speech)
      check(
        refuses(() => voice.quiesce(handoff)) && voice.operation === source,
        "source speech invalidates quiet cutover boundary",
      )
      sourcechannel.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }))
      await until(() => !source.speech)
      const boundary = voice.quiesce(handoff)
      check(
        voice.mute(true) && !candidate.media.getAudioTracks()[0].enabled,
        "mute during preparation disables source and retains silent candidate",
      )
      const receipt = voice.cutover(boundary)
      check(
        receipt.phase === "cutover" &&
          voice.operation === candidate &&
          !source.media.getAudioTracks()[0].enabled &&
          source.audio.muted &&
          !candidate.media.getAudioTracks()[0].enabled,
        "cutover transfers ownership and preserves latest user mute",
      )
      check(
        voice.cutover({ ...boundary }) === receipt,
        "identical cutover returns exact receipt without repeating effects",
      )
      voice.mute(false)
      await until(() => signal(candidatepeer) && !signal(sourcepeer))
      check(
        source.media.getAudioTracks()[0].readyState === "live",
        "real cutover carries target signal and source silence before source retirement",
      )
      check(
        !voice.retire(handoff.target) && voice.retire(handoff.source) && voice.retire(handoff.source),
        "retirement refuses active target and is idempotent for source",
      )
      check(
        source.media.getAudioTracks()[0].readyState === "ended" &&
          candidate.media.getAudioTracks()[0].readyState === "live" &&
          voice.mute(false),
        "source retirement leaves independent candidate clone live and usable",
      )
      await until(() => signal(candidatepeer) && !signal(sourcepeer))
      check(true, "real target carries signal after source retirement while old sender stays silent")
      await voice.stop()
      check(candidate.media.getAudioTracks()[0].readyState === "ended", "global stop ends replacement microphone")

      await voice.start({ sessionID: "session-warm", requestID: "source-failure" }, exchange)
      const retained = voice.operation
      const failure = { ...handoff, id: "handoff-failure", source: "source-failure", target: "target-failure" }
      await voice.prepare(failure, exchange)
      const rejected = voice.candidate
      await until(() => channels.get(peers.at(-1))?.readyState === "open")
      const priorerrors = events.errors.length
      channels.get(peers.at(-1)).send(JSON.stringify({ type: "response.created", response: { id: "unsolicited" } }))
      await until(() => rejected.closed)
      check(
        voice.operation === retained &&
          retained.media.getAudioTracks()[0].enabled &&
          events.errors.length === priorerrors &&
          rejected.media.getAudioTracks()[0].readyState === "ended",
        "unsolicited candidate generation cleans only candidate and preserves active call",
      )
      check(
        refuses(() => voice.cutover(failure)) && voice.operation === retained,
        "failed preparation cannot be promoted by stale cutover",
      )
      let candidateanswer
      const waiting = voice
        .prepare(
          { ...failure, id: "handoff-stop", target: "target-stop" },
          () =>
            new Promise((resolve) => {
              candidateanswer = resolve
            }),
        )
        .then(
          () => "resolved",
          () => "cancelled",
        )
      await until(() => !!candidateanswer)
      const pendingcandidate = voice.candidate
      await voice.stop()
      check(
        (await waiting) === "cancelled" &&
          retained.media.getAudioTracks()[0].readyState === "ended" &&
          pendingcandidate.media.getAudioTracks()[0].readyState === "ended",
        "global stop cancels held candidate exchange and releases both independent tracks",
      )
      candidateanswer("late-invalid-answer")
      await new Promise((resolve) => setTimeout(resolve, 30))
      check(!voice.operation && !voice.candidate, "late candidate answer cannot revive globally stopped voice")
      await voice.start({ sessionID: "session-warm", requestID: "source-loss" }, exchange)
      const lost = voice.operation
      const lostpeer = peers.at(-1)
      await until(() => channels.get(lostpeer)?.readyState === "open")
      const lostchannel = channels.get(lostpeer)
      const loss = { ...handoff, id: "handoff-loss", source: "source-loss", target: "target-loss" }
      await voice.prepare(loss, exchange)
      const orphan = voice.candidate
      lostchannel.send(JSON.stringify({ type: "error", error: { code: "source_disconnected" } }))
      await until(() => lost.closed)
      check(
        lost.media.getAudioTracks()[0].readyState === "ended" &&
          orphan.media.getAudioTracks()[0].readyState === "ended" &&
          !voice.operation &&
          !voice.candidate,
        "source failure releases both media roles without automatic promotion",
      )
      check(
        refuses(() => voice.cutover(loss)),
        "prepared receipt cannot authorize replacement after source failure",
      )
      await voice.start({ sessionID: "session-warm", requestID: "source-partial" }, exchange)
      const partialsource = voice.operation
      const partial = { ...handoff, id: "handoff-partial", source: "source-partial", target: "target-partial" }
      await voice.prepare(partial, exchange)
      const partialtarget = voice.candidate
      const partialquiet = voice.quiesce(partial)
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted")
      Object.defineProperty(partialtarget.audio, "muted", {
        get() {
          return descriptor.get.call(this)
        },
        set(value) {
          if (!value) throw new Error("Injected local output cutover failure")
          descriptor.set.call(this, value)
        },
      })
      check(
        refuses(() => voice.cutover(partialquiet)) &&
          partialsource.media.getAudioTracks()[0].readyState === "ended" &&
          partialtarget.media.getAudioTracks()[0].readyState === "ended",
        "partial cutover failure stops both media effects without reviving source",
      )
      check(
        refuses(() => voice.cutover(partialquiet)) && !voice.operation && !voice.candidate && !voice.retiring,
        "unknown cutover cannot automatically replay media activation",
      )
      let owner = { id: "bridge-source", session: "session-bridge", engine: "realtime" }
      let generation = 1
      let busy = false
      let hold = false
      const bridgeevents = []
      const hoststops = []
      let disposal
      const recovery = Voice.createRoot((dispose) => {
        disposal = dispose
        return Voice.createVoiceRecovery(
          () => "session-bridge",
          () => voice.stop(),
          () => {
            throw new Error("Local cleanup failed")
          },
        )
      })
      const stopbridge = () => {
        bridge.close()
        const held = [voice.operation, voice.candidate, voice.retiring].filter(Boolean)
        owner = undefined
        recovery.close()
        hoststops.push(
          held.every((operation) => operation.media.getAudioTracks().every((track) => track.readyState === "ended")),
        )
      }
      const bridge = Voice.createHandoff({
        media: voice,
        current: () => owner,
        session: () => "session-bridge",
        generation: () => generation,
        busy: () => busy,
        switched: (identity) => {
          owner = { ...owner, id: identity.target }
          recovery.bind(owner)
        },
        ended: stopbridge,
        post: (event) => {
          bridgeevents.push(event)
          if (event.type === "speechOpenAIHandoffOffer" && !hold)
            void exchange(event.sdp).then((sdp) =>
              bridge.receive({ type: "speechOpenAIHandoffAnswer", handoff: event.handoff, sdp }),
            )
        },
      })
      recovery.bind(owner)
      await voice.start({ sessionID: owner.session, requestID: owner.id }, exchange)
      const identity = {
        version: 1,
        id: "bridge-handoff",
        sessionID: owner.session,
        source: owner.id,
        target: "bridge-target",
      }
      bridge.receive({ type: "speechOpenAIHandoffPrepare", handoff: identity })
      await until(() => bridgeevents.some((event) => event.type === "speechOpenAIHandoffPrepared"))
      check(
        owner.id === identity.source && voice.operation.requestID === identity.source,
        "bridge preserves source UI owner through candidate preparation",
      )
      bridge.receive({ type: "speechOpenAIHandoffQuiesce", handoff: { ...identity, id: "foreign" } })
      check(voice.operation.media.getAudioTracks()[0].enabled, "stale bridge identity cannot quiesce active microphone")
      bridge.receive({ type: "speechOpenAIHandoffQuiesce", handoff: identity })
      const token = bridgeevents.find((event) => event.type === "speechOpenAIHandoffQuiesced").quiet
      check(
        !voice.operation.media.getAudioTracks()[0].enabled && token.phase === "quiesced",
        "bridge disables source input before emitting exact quiescence acknowledgement",
      )
      voice.mute(false)
      check(
        !voice.operation.media.getAudioTracks()[0].enabled,
        "unmute intent cannot reopen quiesced source before authority decision",
      )
      bridge.receive({ type: "speechOpenAIHandoffCutover", quiet: { ...token, epoch: token.epoch + 1 } })
      check(owner.id === identity.source, "changed quiescence epoch cannot switch media or UI ownership")
      bridge.receive({ type: "speechOpenAIHandoffCutover", quiet: token })
      check(
        owner.id === identity.target && bridgeevents.at(-1).type === "speechOpenAIHandoffCutoverAck",
        "bridge switches UI routing before posting exact media cutover acknowledgement",
      )
      bridge.receive({ type: "speechOpenAIHandoffCutover", quiet: token })
      check(
        bridgeevents.at(-1).ack.target === identity.target,
        "duplicate bridge cutover returns correlated target acknowledgement",
      )
      bridge.receive({ type: "speechOpenAIHandoffRetire", handoff: identity })
      check(
        bridgeevents.at(-1).confirmed && voice.operation.media.getAudioTracks()[0].readyState === "live",
        "bridge retires source separately while active target remains live",
      )
      const promoted = voice.operation
      bridge.receive({ type: "speechOpenAIHandoffNotice", handoff: identity, reason: "unavailable" })
      check(
        !owner && promoted.media.getAudioTracks()[0].readyState === "ended" && hoststops.at(-1),
        "matching promoted notice after retirement closes active target locally before host Stop",
      )
      bridge.close()
      await voice.stop()
      owner = { id: "bridge-cancel", session: "session-bridge", engine: "realtime" }
      recovery.bind(owner)
      generation++
      await voice.start({ sessionID: owner.session, requestID: owner.id }, exchange)
      const denied = { ...identity, id: "bridge-denied", source: owner.id, target: "bridge-denied-target" }
      bridge.receive({ type: "speechOpenAIHandoffPrepare", handoff: denied })
      await until(() =>
        bridgeevents.some((event) => event.type === "speechOpenAIHandoffPrepared" && event.ack.id === denied.id),
      )
      busy = true
      bridge.receive({ type: "speechOpenAIHandoffQuiesce", handoff: denied })
      check(
        bridgeevents.at(-1).reason === "activity" && voice.operation.media.getAudioTracks()[0].enabled,
        "pending image or control state refuses quiescence without silencing source",
      )
      bridge.receive({ type: "speechOpenAIHandoffCancel", handoff: denied, restore: true })
      await until(() => !voice.candidate)
      check(
        voice.operation.requestID === denied.source && voice.operation.media.getAudioTracks()[0].enabled,
        "definite host refusal restores only matching original source",
      )
      busy = false
      const notice = { ...denied, id: "bridge-notice", target: "bridge-notice-target" }
      bridge.receive({ type: "speechOpenAIHandoffPrepare", handoff: notice })
      await until(() =>
        bridgeevents.some((event) => event.type === "speechOpenAIHandoffPrepared" && event.ack.id === notice.id),
      )
      bridge.receive({ type: "speechOpenAIHandoffNotice", handoff: notice, reason: "unavailable" })
      check(
        bridgeevents.at(-1).reason === "unavailable" &&
          !voice.candidate &&
          voice.operation.media.getAudioTracks()[0].enabled,
        "host candidate notice releases candidate and requests reconciliation while source stays active",
      )
      bridge.receive({ type: "speechOpenAIHandoffCancel", handoff: notice, restore: true })
      await new Promise((resolve) => setTimeout(resolve, 20))
      bridge.close()
      await voice.stop()
      owner = { id: "bridge-activity", session: "session-bridge", engine: "realtime" }
      recovery.bind(owner)
      generation++
      busy = false
      await voice.start({ sessionID: owner.session, requestID: owner.id }, exchange)
      const activitysource = voice.operation
      const activitypeer = peers.at(-1)
      await until(() => channels.get(activitypeer)?.readyState === "open")
      const activity = {
        ...identity,
        id: "bridge-activity-handoff",
        source: owner.id,
        target: "bridge-activity-target",
      }
      bridge.receive({ type: "speechOpenAIHandoffPrepare", handoff: activity })
      await until(() =>
        bridgeevents.some((event) => event.type === "speechOpenAIHandoffPrepared" && event.ack.id === activity.id),
      )
      const activitytarget = voice.candidate
      bridge.receive({ type: "speechOpenAIHandoffQuiesce", handoff: activity })
      const activityquiet = bridgeevents.at(-1).quiet
      channels.get(activitypeer).send(JSON.stringify({ type: "input_audio_buffer.speech_started" }))
      await until(() => activitysource.speech)
      voice.mute(false)
      check(
        !activitysource.media.getAudioTracks()[0].enabled,
        "late source activity invalidates token without releasing physical input fence",
      )
      bridge.receive({ type: "speechOpenAIHandoffCutover", quiet: activityquiet })
      await until(() => activitysource.media.getAudioTracks()[0].readyState === "ended")
      check(
        !owner && activitytarget.media.getAudioTracks()[0].readyState === "ended",
        "late source activity after quiescence closes both roles instead of uncertain cutover",
      )
      check(hoststops.at(-1), "actual recovery callback closes all local media before host Stop publication")
      bridge.close()
      await voice.stop()
      owner = { id: "bridge-stale", session: "session-bridge", engine: "realtime" }
      recovery.bind(owner)
      generation++
      hold = true
      await voice.start({ sessionID: owner.session, requestID: owner.id }, exchange)
      const stale = { ...identity, id: "bridge-stale-handoff", source: owner.id, target: "bridge-stale-target" }
      bridge.receive({ type: "speechOpenAIHandoffPrepare", handoff: stale })
      await until(() =>
        bridgeevents.some((event) => event.type === "speechOpenAIHandoffOffer" && event.handoff.id === stale.id),
      )
      generation++
      bridge.receive({ type: "speechOpenAIHandoffAnswer", handoff: stale, sdp: "late-invalid-answer" })
      check(
        !bridgeevents.some((event) => event.type === "speechOpenAIHandoffPrepared" && event.ack.id === stale.id),
        "changed local generation rejects late candidate answer and readiness acknowledgement",
      )
      bridge.close()
      await until(() => !voice.candidate)
      check(
        voice.operation.media.getAudioTracks()[0].enabled,
        "cancelling stale candidate preparation preserves still-owned source",
      )
      await voice.stop()
      disposal()
      return checks
    } finally {
      await voice.stop()
      navigator.mediaDevices.getUserMedia = original
      for (const peer of peers) peer.close()
      for (const stream of captures) for (const track of stream.getTracks()) track.stop()
      for (const context of contexts) await context.close()
    }
  })
  assert.equal(result.length, 77)
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
