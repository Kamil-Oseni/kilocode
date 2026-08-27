import { createSignal, onCleanup } from "solid-js"
import { showToast } from "@kilocode/kilo-ui/toast"
import type { Accessor } from "solid-js"
import type { ExtensionMessage, WebviewMessage } from "../../types/messages"
import { SpeechCapture } from "./capture" // raya_change - Milestone H browser microphone and VAD

type VSCode = {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
}

type Server = {
  goToLogin: () => void
}

type Lang = {
  t: (key: string) => string
}

export type SpeechState = "idle" | "starting" | "recording" | "transcribing" | "error"

export type InsertTranscript = (text: string) => boolean | void // raya_change - false means the transcript was a local voice command

type StartOptions = {
  model: string
  insert: InsertTranscript
  handsFree?: boolean // raya_change - Milestone H
  threshold?: number // raya_change - Milestone H
  silenceMs?: number // raya_change - Milestone H
  echoSuppression?: boolean // raya_change - adaptive residual-echo floor during full-duplex playback
  onSpeech?: () => void // raya_change - Milestone H barge-in
  onSilence?: () => void // raya_change - Milestone H hands-free turn boundary
}

type StopOptions = {
  done?: () => void
  ready?: () => boolean
}

export type SpeechToText = {
  state: Accessor<SpeechState>
  error: Accessor<string | undefined>
  active: Accessor<boolean>
  start: (opts: StartOptions) => void
  stop: (opts?: StopOptions) => void
  rejectEcho: () => void
  cancel: () => void
  clear: () => void
}

export function useSpeechToText(vscode: VSCode, server: Server, lang: Lang): SpeechToText {
  const [state, setState] = createSignal<SpeechState>("idle")
  const [error, setError] = createSignal<string | undefined>()
  const active = () => state() === "starting" || state() === "recording" || state() === "transcribing"
  const prefix = globalThis.crypto?.randomUUID?.() ?? `stt-${Math.random().toString(36).slice(2)}`

  let request = ""
  let counter = 0
  let insert: InsertTranscript | undefined
  let done: (() => void) | undefined
  let ready: (() => boolean) | undefined
  let pending = false
  const capture = new SpeechCapture() // raya_change - Milestone H
  let local = false // raya_change - Milestone H
  let model = "" // raya_change - Milestone H
  let speech: (() => void) | undefined // raya_change - Milestone H extension-host VAD
  let silence: (() => void) | undefined // raya_change - Milestone H extension-host VAD

  const unsub = vscode.onMessage((msg) => {
    if (!isSpeechMessage(msg)) return
    if (msg.requestId !== request) return

    if (msg.type === "speechToTextStarted") {
      if (state() !== "starting") return
      setState("recording")
      if (pending) transcribe()
      return
    }

    // raya_change start - Milestone H extension-host VAD fallback
    if (msg.type === "speechToTextSpeech") {
      vscode.postMessage({ type: "speechPlaybackCancel" })
      speech?.()
      return
    }
    if (msg.type === "speechToTextSilence") {
      silence?.()
      return
    }
    // raya_change end

    if (msg.type === "speechToTextCancelled") {
      cleanup()
      setState("idle")
      setError(undefined)
      return
    }

    if (msg.type === "speechToTextError") {
      if (msg.code === "not_authenticated") {
        login()
        return
      }
      fail(msg.error)
      return
    }

    const text = msg.text.trim()
    if (!text) {
      fail(lang.t("speechToText.error.emptyTranscript"))
      return
    }

    const next = ready?.() === false ? undefined : done
    const accepted = insert?.(text)
    cleanup()
    setState("idle")
    setError(undefined)
    if (accepted !== false) next?.() // raya_change - do not send a voice-mode command as a chat turn
  })

  onCleanup(() => {
    unsub()
    cancel()
  })

  function start(opts: StartOptions) {
    if (active()) return
    insert = opts.insert
    model = opts.model
    speech = opts.onSpeech
    silence = opts.onSilence
    setError(undefined)

    counter++
    request = `${prefix}-${counter}`
    setState("starting")
    // raya_change start - capture in the webview so hands-free VAD and barge-in see the live microphone
    if (typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined") {
      local = true
      if (!opts.handsFree) vscode.postMessage({ type: "speechPlaybackCancel" })
      void capture
        .start({
          handsFree: opts.handsFree ?? false,
          threshold: opts.threshold ?? 0.025,
          silenceMs: opts.silenceMs ?? 900,
          echoSuppression: opts.echoSuppression,
          onSpeech: () => {
            vscode.postMessage({ type: "speechPlaybackCancel" })
            opts.onSpeech?.()
          },
          onSilence: () => opts.onSilence?.(),
        })
        .then(() => {
          if (state() === "starting") setState("recording")
          if (pending) transcribe()
        })
        .catch((err: unknown) => {
          if (state() !== "starting") return
          console.warn("[Kilo New] Webview microphone unavailable; using extension-host capture:", err)
          local = false
          startHost(opts)
        })
      return
    }
    local = false
    startHost(opts)
    // raya_change end
  }

  // raya_change - VS Code can deny webview microphone permission even when a native input device is available
  function startHost(opts: StartOptions) {
    vscode.postMessage({
      type: "speechToTextStart",
      requestId: request,
      model: opts.model,
      language: langCode(),
      handsFree: opts.handsFree,
      threshold: opts.threshold,
      silenceMs: opts.silenceMs,
    })
  }

  function stop(opts?: StopOptions) {
    if (state() !== "starting" && state() !== "recording") return
    done = opts?.done
    ready = opts?.ready
    if (state() === "starting") {
      pending = true
      return
    }
    transcribe()
  }

  function transcribe() {
    pending = false
    setState("transcribing")
    // raya_change start - send the actual webview recording to the configured STT endpoint
    if (local) {
      const id = request
      void capture.stop().then(
        (audio) =>
          vscode.postMessage({
            type: "speechToTextSubmit",
            requestId: id,
            model,
            language: langCode(),
            format: audio.format,
            data: audio.data,
          }),
        (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
      )
      return
    }
    // raya_change end
    vscode.postMessage({ type: "speechToTextStop", requestId: request })
  }

  function cancel() {
    if (local) capture.cancel() // raya_change - Milestone H
    if (!local && request && active()) vscode.postMessage({ type: "speechToTextCancel", requestId: request })
    cleanup()
    setState("idle")
    setError(undefined)
  }

  function clear() {
    if (state() !== "error") return
    cleanup()
    setState("idle")
    setError(undefined)
  }

  function login() {
    const message = lang.t("speechToText.error.loginRequired")
    showToast({
      variant: "error",
      title: message,
      actions: [
        { label: lang.t("common.signIn"), onClick: server.goToLogin },
        { label: lang.t("common.dismiss"), onClick: "dismiss" },
      ],
    })
    fail(message, false)
  }

  function fail(message: string, toast = true) {
    cleanup()
    setState("error")
    setError(message)
    if (toast) showToast({ variant: "error", title: lang.t("speechToText.error.title"), description: message })
  }

  function cleanup() {
    request = ""
    insert = undefined
    done = undefined
    ready = undefined
    pending = false
    local = false // raya_change - Milestone H
    model = "" // raya_change - Milestone H
    speech = undefined // raya_change - Milestone H
    silence = undefined // raya_change - Milestone H
  }

  return { state, error, active, start, stop, rejectEcho: () => capture.rejectEcho(), cancel, clear }
}

function isSpeechMessage(msg: ExtensionMessage): msg is Extract<
  ExtensionMessage,
  {
    type:
      | "speechToTextStarted"
      | "speechToTextSpeech"
      | "speechToTextSilence"
      | "speechToTextCancelled"
      | "speechToTextResult"
      | "speechToTextError"
  }
> {
  return (
    msg.type === "speechToTextStarted" ||
    msg.type === "speechToTextSpeech" ||
    msg.type === "speechToTextSilence" ||
    msg.type === "speechToTextCancelled" ||
    msg.type === "speechToTextResult" ||
    msg.type === "speechToTextError"
  )
}

function langCode() {
  return (navigator.language || "en").split("-")[0] || "en"
}
