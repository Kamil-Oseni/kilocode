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
import { createVoiceImages } from "./voice-images"
import { OpenAIVoice } from "./openai-voice"
import { useSession } from "./session"

type VoiceStatus = "off" | "connecting" | "listening" | "thinking" | "speaking" | "degraded"

type VoiceContextValue = {
  settings: Accessor<SpeechState>
  playing: Accessor<boolean>
  image: ReturnType<typeof createVoiceImages>["state"]
  share: (imageID: string, data: string) => void
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
  const [settings, setSettings] = createSignal<SpeechState>({
    ...DEFAULT_SPEECH_SETTINGS,
    hasOpenAIKey: false,
    hasRealtimeKey: false,
    hasSttKey: false,
    hasTtsKey: false,
  })
  const [muted, setMuted] = createSignal(false)
  const [playing, setPlaying] = createSignal(false)
  const [status, setStatus] = createSignal<VoiceStatus>("off")
  const [transcript, setTranscript] = createSignal<RealtimeTranscript>()
  const [aec, setAec] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const [cascade, setCascade] = createSignal(false)
  const state = { request: "", generation: 0, terminal: false }
  let call: { id: string; session: string } | undefined
  let pending: { id: string; resolve: (sdp: string) => void; reject: (error: Error) => void } | undefined
  const closing = new Set<string>()
  const legacy = () => settings().voiceEngine !== "openai-realtime" && !call && closing.size === 0
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
      if (call) setTranscript(value)
    },
    aec: setAec,
    notice: setError,
    error: failOpenAI,
  })

  const images = createVoiceImages({
    current: () => call,
    register: (id) => native.image(id),
    post: (message) => vscode.postMessage(message),
  })

  function stopOpenAI() {
    images.clear()
    setMuted(false)
    const current = call
    call = undefined
    if (pending) {
      const waiting = pending
      pending = undefined
      waiting.reject(new Error("Voice connection cancelled."))
    }
    if (current) {
      if (closing.size >= 32) closing.delete(closing.values().next().value!)
      closing.add(current.id)
      vscode.postMessage({ type: "speechOpenAIStop", requestId: current.id })
    }
    void native.stop().catch(() => {
      setError("Microphone or audio cleanup failed. End voice again before reconnecting.")
      setStatus("degraded")
    })
  }

  function failOpenAI(message: string) {
    if (!call) return
    setError(message)
    setStatus("degraded")
    setPlaying(false)
    stopOpenAI()
  }

  function startOpenAI(id: string) {
    if (call || closing.size) {
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
    const current = { id: crypto.randomUUID(), session: id }
    call = current
    state.generation++
    void native
      .start(
        { sessionID: id, requestID: current.id },
        (sdp) =>
          new Promise<string>((resolve, reject) => {
            if (call !== current) return reject(new Error("Voice connection cancelled."))
            pending = { id: current.id, resolve, reject }
            vscode.postMessage({ type: "speechOpenAIStart", requestId: current.id, sessionID: id, sdp })
          }),
      )
      .catch((error: unknown) => {
        if (call === current) failOpenAI(error instanceof Error ? error.message : "OpenAI voice could not connect.")
      })
  }

  function openaiMessage(message: ExtensionMessage) {
    if (images.receive(message)) return true
    if (message.type === "speechOpenAIReady") {
      if (call?.id !== message.requestId || pending?.id !== message.requestId) return true
      const waiting = pending
      pending = undefined
      waiting.resolve(message.sdp)
      return true
    }
    if (message.type === "speechOpenAIError") {
      if (call?.id === message.requestId) failOpenAI(message.error)
      if (closing.has(message.requestId)) {
        setError(message.error)
        if (!call) setStatus("degraded")
      }
      return true
    }
    if (message.type !== "speechOpenAIStopped") return false
    closing.delete(message.requestId)
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
    if (openaiMessage(message)) return
    if (message.type === "speechSettingsLoaded") {
      if (message.settings.voiceEngine !== settings().voiceEngine) stop()
      setSettings(message.settings)
      loop.set(message.settings.voiceEngine === "openai-realtime" ? "off" : message.settings.mode)
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
    if (patch.voiceEngine && patch.voiceEngine !== settings().voiceEngine) stop()
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
    loop.set(settings().voiceEngine === "openai-realtime" ? "off" : mode)
  }

  createEffect(() => {
    const id = session.currentSessionID()
    if (!call || call.session === id) return
    stop()
    setTranscript(undefined)
    setError("Voice ended because you changed tasks. Work already started remains in its original conversation.")
  })

  return (
    <Context.Provider
      value={{
        settings,
        playing,
        image: images.state,
        share: images.share,
        muted,
        mute: () => {
          if (!call) return
          const value = !muted()
          if (native.mute(value)) setMuted(value)
        },
        interrupt: () => {
          if (!call) return
          const action = native.interrupt()
          if (action) vscode.postMessage({ type: "speechOpenAIInterrupt", requestId: call.id, ...action })
        },
        status,
        transcript,
        aec,
        cascade,
        error,
        update,
        setKey: (kind, key) => vscode.postMessage({ type: "speechKeyUpdate", kind, key }),
        setMode,
        start: (sessionID) => {
          if (call || closing.size) {
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
          if (settings().voiceEngine === "openai-realtime") {
            startOpenAI(sessionID)
            return
          }
          vscode.postMessage({ type: "speechRealtimeStart", sessionID })
        },
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
