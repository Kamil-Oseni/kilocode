// raya_change - Milestone H intelligent voice round-trip and streaming playback context
import { createContext, createSignal, onCleanup, useContext, type Accessor, type ParentComponent } from "solid-js"
import type { ExtensionMessage } from "../types/messages"
import {
  DEFAULT_SPEECH_SETTINGS,
  type SpeechSettings,
  type SpeechState,
  type VoiceMode,
} from "../../../src/shared/speech"
import { useVSCode } from "./vscode"
import { VoiceLoop } from "./voice-loop"
import { RealtimeVoice, type RealtimeTranscript } from "./realtime-voice" // raya_change - native realtime thin client
import { StreamPlayer } from "./stream-player" // raya_change - user-gesture-safe MiniMax audio sink
import { VoiceEcho } from "./voice-echo" // raya_change - residual spoken-response exclusion

type VoiceStatus = "off" | "connecting" | "listening" | "thinking" | "speaking" | "degraded"

type VoiceContextValue = {
  settings: Accessor<SpeechState>
  playing: Accessor<boolean>
  status: Accessor<VoiceStatus>
  transcript: Accessor<RealtimeTranscript | undefined>
  aec: Accessor<boolean>
  cascade: Accessor<boolean>
  error: Accessor<string | undefined>
  update: (settings: Partial<SpeechSettings>) => void
  setKey: (kind: "realtime" | "stt" | "tts", key?: string) => void
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
  const [settings, setSettings] = createSignal<SpeechState>({
    ...DEFAULT_SPEECH_SETTINGS,
    hasRealtimeKey: false,
    hasSttKey: false,
    hasTtsKey: false,
  })
  const [playing, setPlaying] = createSignal(false)
  const [status, setStatus] = createSignal<VoiceStatus>("off")
  const [transcript, setTranscript] = createSignal<RealtimeTranscript>()
  const [aec, setAec] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const [cascade, setCascade] = createSignal(false)
  const state = { request: "" }
  const echo = new VoiceEcho()
  const player = new StreamPlayer(() => {
    setPlaying(false)
    loop.done()
    if (settings().mode === "hands-free" && cascade()) setStatus("listening")
  }, setError)
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
    setCascade(true)
    setError(message)
    setStatus("degraded")
    const fallback = settings().sttEndpoint && settings().hasSttKey && settings().hasTtsKey
    if (!fallback) return
    loop.set("hands-free")
    queueMicrotask(() => window.dispatchEvent(new CustomEvent("rayaVoiceListen")))
  }
  const realtime = new RealtimeVoice({
    status: setStatus,
    transcript: setTranscript,
    error: setError,
    fallback: degrade,
    aec: setAec,
  })
  function demote(message: Extract<ExtensionMessage, { type: "speechRealtimeError" }>) {
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

  const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type === "speechSettingsLoaded") {
      setSettings(message.settings)
      loop.set(message.settings.mode)
      return
    }
    if (message.type === "speechPlaybackChunk") {
      if (message.text) echo.set(message.text)
      const starting = message.requestId !== state.request || !playing()
      // raya_change - extension-host Voice completion owns its generated playback request
      if (message.requestId !== state.request) {
        if (settings().mode !== "hands-free") return
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
      return
    }
    if (message.type === "speechPlaybackDone") {
      if (message.requestId !== state.request) return
      player.finish()
      return
    }
    if (message.type === "speechPlaybackError") {
      if (message.requestId !== state.request) return
      console.error("[Kilo New] Speech playback failed:", message.error)
      setError(message.error)
      player.stop()
      return
    }
    if (message.type === "speechRealtimeReady") {
      setCascade(false)
      setError(undefined)
      void realtime.start(message.connection).catch(async (err: unknown) => {
        const error = err instanceof Error ? err.message : String(err)
        await realtime.stop()
        degrade(error)
      })
      return
    }
    if (message.type === "speechRealtimeError") {
      demote(message)
      return
    }
    if (message.type === "speechRealtimeStopped") {
      setStatus("off")
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
    void realtime.stop()
    vscode.postMessage({ type: "speechRealtimeStop" })
    player.stop(false)
    vscode.postMessage({ type: "speechPlaybackCancel", requestId: state.request || undefined })
  })

  const update = (patch: Partial<SpeechSettings>) => {
    const next = { ...settings(), ...patch }
    setSettings(next)
    vscode.postMessage({
      type: "speechSettingsUpdate",
      settings: {
        voiceEngine: next.voiceEngine,
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
    setCascade(false)
    echo.clear()
    void realtime.stop()
    vscode.postMessage({ type: "speechRealtimeStop" })
    loop.stop()
    player.stop(false) // raya_change - only full orb deactivation closes the webview audio sink
    setStatus("off")
  }
  const setMode = (mode: VoiceMode) => {
    update(mode === "hands-free" ? { mode, autoSpeak: true } : { mode }) // raya_change - the orb always implies spoken output
    loop.set(mode)
  }

  return (
    <Context.Provider
      value={{
        settings,
        playing,
        status,
        transcript,
        aec,
        cascade,
        error,
        update,
        setKey: (kind, key) => vscode.postMessage({ type: "speechKeyUpdate", kind, key }),
        setMode,
        start: (sessionID) => {
          setCascade(false)
          echo.clear()
          player.unlock()
          setTranscript(undefined)
          setError(undefined)
          setStatus("connecting")
          update({ mode: "hands-free", autoSpeak: false })
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

