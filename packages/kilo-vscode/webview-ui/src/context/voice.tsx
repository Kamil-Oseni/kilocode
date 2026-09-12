// raya_change - Milestone H intelligent voice round-trip and streaming playback context
import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type ParentComponent,
} from "solid-js"
import type { ExtensionMessage } from "../types/messages"
import {
  DEFAULT_SPEECH_SETTINGS,
  type SpeechSettings,
  type SpeechState,
  type VoiceMode,
  type SpeechKey,
} from "../../../src/shared/speech"
import { useVSCode } from "./vscode"
import { VoiceLoop } from "./voice-loop"
import { RealtimeVoice, type RealtimeTranscript } from "./realtime-voice" // raya_change - native realtime thin client
import { StreamPlayer } from "./stream-player" // raya_change - user-gesture-safe MiniMax audio sink
import { VoiceEcho } from "./voice-echo" // raya_change - residual spoken-response exclusion
import { createVoiceRecovery } from "./voice-recovery"
import { createVoiceUsage } from "./voice-usage"
import { createVoiceImages } from "./voice-images"
import { LiveVoice, pump } from "./live-voice"
import type { LiveContext } from "../../../src/shared/live-context"
import type { LiveUsage } from "../../../src/shared/live-usage"
import { OpenAIVoice } from "./openai-voice"
import { useSession } from "./session"

type VoiceStatus = "off" | "connecting" | "listening" | "thinking" | "speaking" | "degraded"

type VoiceContextValue = {
  settings: Accessor<SpeechState>
  playing: Accessor<boolean>
  recovery: ReturnType<typeof createVoiceRecovery>["state"]
  startBlocked: Accessor<boolean>
  restart: () => void
  usage: ReturnType<typeof createVoiceUsage>["state"]
  image: ReturnType<typeof createVoiceImages>["state"]
  share: (imageID: string, data: string) => void
  live: Accessor<boolean>
  captions: Accessor<ReturnType<LiveContext["snapshot"]> | undefined>
  duration: Accessor<LiveUsage | undefined>
  silenced: Accessor<boolean>
  resume: () => void
  muted: Accessor<boolean>
  mute: () => void
  interrupt: () => void
  status: Accessor<VoiceStatus>
  transcript: Accessor<RealtimeTranscript | undefined>
  aec: Accessor<boolean>
  cascade: Accessor<boolean>
  error: Accessor<string | undefined>
  update: (settings: Partial<SpeechSettings>) => void
  setKey: (kind: SpeechKey, key?: string) => void
  setMode: (mode: VoiceMode) => void
  start: (sessionID: string) => void
  listen: () => void
  hear: () => void
  wait: () => void
  clean: (text: string) => string | undefined
  recover: () => boolean
  test: () => void
  stop: () => void
}

const Context = createContext<VoiceContextValue>()

export const VoiceProvider: ParentComponent = (props) => {
  const vscode = useVSCode()
  const session = useSession()
  const usage = createVoiceUsage(session.currentSessionID)
  const [settings, setSettings] = createSignal<SpeechState>({
    ...DEFAULT_SPEECH_SETTINGS,
    hasOpenAIKey: false,
    hasRealtimeKey: false,
    hasSttKey: false,
    hasTtsKey: false,
  })
  const [captions, setCaptions] = createSignal<ReturnType<LiveContext["snapshot"]>>()
  const [duration, setDuration] = createSignal<LiveUsage>()
  const [silenced, setSilenced] = createSignal(false)
  const [muted, setMuted] = createSignal(false)
  const [playing, setPlaying] = createSignal(false)
  const [status, setStatus] = createSignal<VoiceStatus>("off")
  const [transcript, setTranscript] = createSignal<RealtimeTranscript>()
  const [aec, setAec] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const [cascade, setCascade] = createSignal(false)
  const state = { request: "", generation: 0, terminal: false }
  let call: { id: string; session: string; engine: "live" | "realtime" } | undefined
  let pending: { id: string; resolve: (sdp: string) => void; reject: (error: Error) => void } | undefined
  let feed: ReturnType<typeof pump> | undefined
  const latest = { mute: "", speak: "" }
  let transport: OpenAIVoice | LiveVoice
  const recovery = createVoiceRecovery(
    session.currentSessionID,
    () => transport.stop(),
    () => {
      if (!recovery.state()) return
      setError("Microphone or audio cleanup failed. Restart Raya before trying voice again.")
      setStatus("degraded")
    },
  )
  const legacy = () => !["openai-realtime", "openai-live"].includes(settings().voiceEngine) && !call && !recovery.blocked()
  const echo = new VoiceEcho()
  const player = new StreamPlayer(
    () => {
      if (!legacy()) return
      setPlaying(false)
      loop.done()
      if (settings().mode === "hands-free" && cascade()) setStatus("listening")
    },
    (message) => {
      if (legacy()) setError(message)
    },
  )
  const loop = new VoiceLoop({
    listen: () => queueMicrotask(() => window.dispatchEvent(new CustomEvent("rayaVoiceListen"))),
    stop: () => {
      vscode.postMessage({ type: "speechPlaybackCancel", requestId: state.request || undefined })
      if (playing()) echo.interrupt(player.elapsed())
      player.reset() // raya_change - interruption preserves the gesture-authorized sink for later turns
      setPlaying(false)
    },
  })
  function degrade(message: string) {
    if (!legacy()) return
    setCascade(true)
    setError(message)
    setStatus("degraded")
    const fallback = settings().sttEndpoint && settings().hasSttKey && settings().hasTtsKey
    if (!fallback) return
    loop.set("hands-free")
    queueMicrotask(() => window.dispatchEvent(new CustomEvent("rayaVoiceListen")))
  }
  const realtime = new RealtimeVoice({
    status: (value) => {
      if (legacy()) setStatus(value)
    },
    transcript: (value) => {
      if (legacy()) setTranscript(value)
    },
    error: (message) => {
      if (!legacy()) return
      setError(message)
      if (!state.terminal) vscode.postMessage({ type: "speechRealtimeStop" })
      state.terminal = true
    },
    fallback: degrade,
    aec: (value) => {
      if (legacy()) setAec(value)
    },
  })
  const native = new OpenAIVoice({
    status: (value) => {
      if (call) setStatus(value)
    },
    transcript: (value) => {
      if (!call) return
      setTranscript((prior) => {
        if (value.sequence !== undefined && prior?.sequence !== undefined && value.sequence < prior.sequence)
          return prior
        return value
      })
    },
    aec: setAec,
    notice: setError,
    error: failOpenAI,
  })

  const live = new LiveVoice({
    status: (value) => { if (call?.engine === "live") setStatus(value) },
    captions: (value) => { if (call?.engine === "live") setCaptions(value) },
    aec: setAec,
    error: failOpenAI,
  }, 12_000, async () => {
    await feed?.close()
    feed = pump()
    if (call) vscode.postMessage({ type: "speechLiveMicStart", requestId: call.id })
    return feed.stream
  })
  transport = native

  const images = createVoiceImages({
    current: () => call,
    register: (id) => call?.engine === "live" || native.image(id),
    post: (message) => vscode.postMessage(message),
  })

  function stopOpenAI() {
    images.clear()
    setMuted(false)
    setSilenced(false)
    setCaptions(undefined)
    latest.mute = ""
    latest.speak = ""
    const current = call
    call = undefined
    if (pending) {
      const waiting = pending
      pending = undefined
      waiting.reject(new Error("Voice connection cancelled."))
    }
    recovery.close()
    const closing = feed
    feed = undefined
    void closing?.close()
    if (current) {
      vscode.postMessage({ type: "speechLiveMicStop", requestId: current.id })
      vscode.postMessage({ type: "speechOpenAIStop", requestId: current.id })
    }
  }

  function failOpenAI(message: string) {
    if (!call) return
    setError(message)
    setStatus("degraded")
    setPlaying(false)
    stopOpenAI()
  }

  function startOpenAI(id: string) {
    if (call || recovery.blocked()) {
      setError("Wait for the previous voice call to close before starting another.")
      return
    }
    if (!settings().hasOpenAIKey) {
      setError("Add your OpenAI API key in Speech settings before starting live voice.")
      setStatus("off")
      return
    }
    if (session.currentSessionID() !== id) {
      setError("Open the voice task before starting its call.")
      setStatus("off")
      return
    }
    const current = { id: crypto.randomUUID(), session: id, engine: settings().voiceEngine === "openai-live" ? "live" as const : "realtime" as const }
    transport = current.engine === "live" ? live : native
    setCaptions(undefined)
    setDuration(undefined)
    setSilenced(false)
    latest.mute = ""
    latest.speak = ""
    call = current
    recovery.bind(current)
    usage.bind(current.id, id)
    state.generation++
    void transport
      .start(
        { sessionID: id, requestID: current.id },
        (sdp) =>
          new Promise<string>((resolve, reject) => {
            if (call !== current) return reject(new Error("Voice connection cancelled."))
            pending = { id: current.id, resolve, reject }
            vscode.postMessage({ type: "speechOpenAIStart", requestId: current.id, sessionID: id, sdp, engine: current.engine === "live" ? "live" : undefined })
          }),
      )
      .catch((error: unknown) => {
        if (call === current) failOpenAI(error instanceof Error ? error.message : "OpenAI voice could not connect.")
      })
  }

  function control(message: Extract<ExtensionMessage, { type: "speechLiveControlResult" }>) {
    if (call?.id !== message.requestId) return
    if (message.eventID !== latest.mute && message.eventID !== latest.speak) return
    if (message.eventID === latest.mute) latest.mute = ""
    if (message.eventID === latest.speak) latest.speak = ""
    if (message.status !== "accepted")
      setError(message.error ?? "Voice control was not confirmed. End voice and reconnect if needed.")
  }

  function ready(message: Extract<ExtensionMessage, { type: "speechOpenAIReady" }>) {
    if (call?.id !== message.requestId || pending?.id !== message.requestId) return
    const waiting = pending
    pending = undefined
    waiting.resolve(message.sdp)
  }

  function failed(message: Extract<ExtensionMessage, { type: "speechOpenAIError" }>) {
    if (call?.id === message.requestId) {
      failOpenAI(message.error)
      return
    }
    if (recovery.fail(message.requestId) && recovery.state()) {
      setError(message.error)
      if (!call) setStatus("degraded")
    }
  }

  function host(message: ExtensionMessage) {
    if (message.type === "speechLiveMicChunk") {
      if (
        call?.id === message.requestId &&
        feed &&
        message.data.length <= 100_000 &&
        /^[A-Za-z0-9+/]+=*$/.test(message.data)
      )
        feed.write(Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0)).buffer)
      return true
    }
    if (message.type !== "speechLiveMicError") return false
    if (call?.id === message.requestId) failOpenAI(message.error)
    return true
  }

  function openaiMessage(message: ExtensionMessage) {
    if (message.type === "speechLiveStarted") {
      live.started(message.requestId)
      return true
    }
    if (host(message)) return true
    if (message.type === "speechLiveUsage") {
      if (
        (call?.id === message.requestId || recovery.state()?.id === message.requestId) &&
        session.currentSessionID() === message.sessionID
      )
        setDuration(message.usage)
      return true
    }
    if (message.type === "speechLiveControlResult") {
      control(message)
      return true
    }
    if (usage.receive(message)) return true
    if (images.receive(message)) return true
    if (message.type === "speechOpenAIReady") {
      ready(message)
      return true
    }
    if (message.type === "speechOpenAIError") {
      failed(message)
      return true
    }
    if (message.type !== "speechOpenAIStopped") return false
    live.finalized(message.requestId)
    recovery.acknowledge(message.requestId)
    return true
  }
  function demote(message: Extract<ExtensionMessage, { type: "speechRealtimeError" }>) {
    if (message.code === "busy") {
      setError(message.error)
      return
    }
    if (message.fallback === "cascade-v1") {
      setCascade(true)
      update({ mode: "hands-free", autoSpeak: true })
      setError(settings().voiceEngine === "cascade-v1" ? undefined : message.error)
      setStatus(settings().voiceEngine === "cascade-v1" ? "connecting" : "degraded")
      loop.set("hands-free")
      queueMicrotask(() => window.dispatchEvent(new CustomEvent("rayaVoiceListen")))
      return
    }
    setError(message.error)
    setStatus("degraded")
  }

  function playback(message: ExtensionMessage) {
    if (message.type === "speechPlaybackChunk") {
      if (message.text) echo.set(message.text)
      const starting = message.requestId !== state.request || !playing()
      // raya_change - extension-host Voice completion owns its generated playback request
      if (message.requestId !== state.request) {
        if (settings().mode !== "hands-free") return true
        player.reset()
        state.request = message.requestId
      }
      setPlaying(true)
      setError(undefined)
      loop.speak()
      if (settings().mode === "hands-free" && status() !== "off") setStatus("speaking")
      player.push(message.data, message.mime)
      if (starting && settings().mode === "hands-free" && cascade()) {
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("rayaVoiceListen")))
      }
      return true
    }
    if (message.type === "speechPlaybackDone") {
      if (message.requestId !== state.request) return true
      player.finish()
      return true
    }
    if (message.type === "speechPlaybackError") {
      if (message.requestId !== state.request) return true
      console.error("[Kilo New] Speech playback failed:", message.error)
      setError(message.error)
      player.stop()
      return true
    }
    return false
  }

  const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type === "connectionState") {
      if (message.state !== "connected") {
        stop()
        recovery.invalidate()
        setCaptions(undefined)
        setDuration(undefined)
        setSilenced(false)
      }
      return
    }
    if (openaiMessage(message)) return
    if (message.type === "speechSettingsLoaded") {
      if (message.settings.voiceEngine !== settings().voiceEngine) {
        stop()
        recovery.invalidate()
        setCaptions(undefined)
        setDuration(undefined)
        setSilenced(false)
      }
      setSettings(message.settings)
      loop.set(["openai-realtime", "openai-live"].includes(message.settings.voiceEngine) ? "off" : message.settings.mode)
      return
    }
    if (!legacy() && (message.type.startsWith("speechRealtime") || message.type.startsWith("speechPlayback"))) {
      if (message.type === "speechRealtimeReady") vscode.postMessage({ type: "speechRealtimeStop" })
      return
    }
    if (playback(message)) return
    if (message.type === "speechRealtimeReady") {
      if (call) {
        vscode.postMessage({ type: "speechRealtimeStop" })
        return
      }
      setCascade(false)
      setError(undefined)
      const generation = ++state.generation
      void realtime.start(message.connection).catch(async () => {
        if (generation !== state.generation) return
        state.terminal = true
        vscode.postMessage({ type: "speechRealtimeStop" })
        await realtime.stop().catch(() => {
          if (generation === state.generation) setError("Voice cleanup failed. Restart Raya before reconnecting.")
        })
        if (generation !== state.generation) return
        setError(
          "Voice connection could not finish. Check your audio device and media frontend, then reconnect or continue typing.",
        )
        setStatus("degraded")
      })
      return
    }
    if (message.type === "speechRealtimeError") {
      demote(message)
      return
    }
    if (message.type === "speechRealtimeStopped") {
      if (call) return
      setStatus(state.terminal ? "degraded" : "off")
      setTranscript(undefined)
    }
  })

  const speak = (text: string, preserve = false) => {
    if (preserve) player.reset()
    if (!preserve) {
      player.stop(false)
      player.unlock()
    }
    setError(undefined)
    state.request = crypto.randomUUID()
    vscode.postMessage({ type: "speechPlaybackStart", requestId: state.request, text })
  }

  vscode.postMessage({ type: "speechSettingsRequest" })
  onCleanup(() => {
    unsubscribe()
    stopOpenAI()
    state.generation++
    void realtime.stop().catch(() => console.error("[Kilo New] Voice cleanup failed during webview disposal."))
    vscode.postMessage({ type: "speechRealtimeStop" })
    player.stop(false)
    vscode.postMessage({ type: "speechPlaybackCancel", requestId: state.request || undefined })
  })

  const update = (patch: Partial<SpeechSettings>) => {
    if (patch.voiceEngine && patch.voiceEngine !== settings().voiceEngine) {
      stop()
      recovery.invalidate()
      setCaptions(undefined)
      setDuration(undefined)
      setSilenced(false)
    }
    const next = { ...settings(), ...patch }
    setSettings(next)
    vscode.postMessage({
      type: "speechSettingsUpdate",
      settings: {
        voiceEngine: next.voiceEngine,
        openaiVoice: next.openaiVoice,
        realtimeEndpoint: next.realtimeEndpoint,
        realtimeModel: next.realtimeModel,
        realtimeVoice: next.realtimeVoice,
        mediaFrontendURL: next.mediaFrontendURL,
        sttEndpoint: next.sttEndpoint,
        sttModel: next.sttModel,
        ttsEndpoint: next.ttsEndpoint,
        ttsModel: next.ttsModel,
        voice: next.voice,
        mode: next.mode,
        autoSpeak: next.autoSpeak,
        cliMirror: next.cliMirror,
        vadThreshold: next.vadThreshold,
        vadSilenceMs: next.vadSilenceMs,
      },
    })
  }
  const stop = () => {
    state.terminal = false
    setCascade(false)
    echo.clear()
    state.generation++
    stopOpenAI()
    void realtime.stop().catch(() => {
      setError("Voice cleanup failed. Restart Raya before reconnecting.")
      setStatus("degraded")
    })
    vscode.postMessage({ type: "speechRealtimeStop" })
    loop.stop()
    player.stop(false) // raya_change - only full orb deactivation closes the webview audio sink
    setStatus("off")
  }
  const setMode = (mode: VoiceMode) => {
    update(mode === "hands-free" ? { mode, autoSpeak: true } : { mode }) // raya_change - the orb always implies spoken output
    loop.set(["openai-realtime", "openai-live"].includes(settings().voiceEngine) ? "off" : mode)
  }

  const start = (sessionID: string) => {
    if (call || recovery.blocked()) {
      setError("End the previous voice call and wait for cleanup before starting another.")
      return
    }
    state.terminal = false
    setCascade(false)
    echo.clear()
    player.unlock()
    setTranscript(undefined)
    setError(undefined)
    setStatus("connecting")
    update({ mode: "hands-free", autoSpeak: false })
    if (["openai-realtime", "openai-live"].includes(settings().voiceEngine)) {
      startOpenAI(sessionID)
      return
    }
    vscode.postMessage({ type: "speechRealtimeStart", sessionID })
  }

  createEffect((previous: string | undefined) => {
    const id = session.currentSessionID()
    if (call && call.session !== id) {
      stop()
      setTranscript(undefined)
      setCaptions(undefined)
      setDuration(undefined)
      setSilenced(false)
      setError("Voice ended because you changed tasks. Work already started remains in its original conversation.")
      return id
    }
    if (previous !== undefined && previous !== id && ["openai-realtime", "openai-live"].includes(settings().voiceEngine)) {
      setStatus("off")
      setTranscript(undefined)
      setCaptions(undefined)
      setDuration(undefined)
      setSilenced(false)
      setError(undefined)
    }
    return id
  })

  return (
    <Context.Provider
      value={{
        settings,
        recovery: recovery.state,
        startBlocked: recovery.blocked,
        restart: () => {
          const value = recovery.state()
          if (!value?.ready || value.session !== session.currentSessionID()) return
          start(value.session)
        },
        playing,
        image: images.state,
        share: images.share,
        live: () => settings().voiceEngine === "openai-live",
        captions,
        duration,
        silenced,
        resume: () => { if (call?.engine === "live" && live.silence(false)) setSilenced(false) },
        muted,
        mute: () => {
          if (!call) return
          const value = !muted()
          if (transport.mute(value)) setMuted(value)
          if (call.engine === "live") {
            const eventID = crypto.randomUUID()
            latest.mute = eventID
            vscode.postMessage({ type: "speechLiveControl", requestId: call.id, eventID, action: value ? "mute" : "unmute" })
          }
        },
        interrupt: () => {
          if (!call) return
          if (call.engine === "live") {
            live.silence(true)
            setSilenced(true)
            const eventID = crypto.randomUUID()
            latest.speak = eventID
            vscode.postMessage({ type: "speechLiveControl", requestId: call.id, eventID, action: "stop_speaking" })
            return
          }
          const action = native.interrupt()
          if (action) vscode.postMessage({ type: "speechOpenAIInterrupt", requestId: call.id, ...action })
        },
        status,
        transcript,
        usage: usage.state,
        aec,
        cascade,
        error,
        update,
        setKey: (kind, key) => vscode.postMessage({ type: "speechKeyUpdate", kind, key }),
        setMode,
        start,
        listen: () => {
          player.unlock()
          loop.listen()
          if (settings().mode === "hands-free" && cascade()) {
            setError(undefined)
            setStatus("listening")
          }
        },
        hear: () => {
          loop.hear()
          if (settings().mode === "hands-free" && cascade()) setStatus("listening")
        },
        wait: () => {
          vscode.postMessage({ type: "speechVoiceTurn" }) // raya_change - extension host speaks authoritative final text
          loop.wait()
          if (settings().mode === "hands-free") setStatus("thinking")
        },
        clean: (text) => echo.clean(text),
        recover: () => {
          const text = echo.take()
          if (!text) return false
          speak(text, true)
          return true
        },
        test: () => speak("Raya voice output is working."),
        stop,
      }}
    >
      {props.children}
    </Context.Provider>
  )
}

export function useVoice() {
  const value = useContext(Context)
  if (!value) throw new Error("useVoice must be used within VoiceProvider")
  return value
}
