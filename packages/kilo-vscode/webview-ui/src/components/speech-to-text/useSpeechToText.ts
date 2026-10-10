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

export type InsertTranscript = (text: string, consume?: () => void) => boolean | void // raya_change - false means the transcript was a local voice command

type StartOptions = {
  model: string
  insert: InsertTranscript
  ownership?: () => () => boolean
  settle?: (signal: AbortSignal) => Promise<boolean>
  retain?: (text: string, request: string) => void
  check?: (text: string, request: string) => boolean
  handsFree?: boolean // raya_change - Milestone H
  threshold?: number // raya_change - Milestone H
  silenceMs?: number // raya_change - Milestone H
  echoSuppression?: boolean // raya_change - adaptive residual-echo floor during full-duplex playback
  onError?: (message: string) => void
  onEmpty?: () => void
  onSpeech?: () => void // raya_change - Milestone H barge-in
  onSilence?: () => void // raya_change - Milestone H hands-free turn boundary
}

type StopOptions = {
  done?: () => void | Promise<void>
  ready?: () => boolean
  settled?: () => void
}

export type SpeechToText = {
  state: Accessor<SpeechState>
  error: Accessor<string | undefined>
  active: Accessor<boolean>
  start: (opts: StartOptions) => void
  stop: (opts?: StopOptions) => void
  rejectEcho: () => void
  cancel: () => void
  suspend: () => void
  clear: () => void
}

export function useSpeechToText(
  vscode: VSCode,
  server: Server,
  lang: Lang,
  session: Accessor<string | undefined>,
): SpeechToText {
  const [state, setState] = createSignal<SpeechState>("idle")
  const [error, setError] = createSignal<string | undefined>()
  const active = () => state() === "starting" || state() === "recording" || state() === "transcribing"
  const prefix = globalThis.crypto?.randomUUID?.() ?? `stt-${Math.random().toString(36).slice(2)}`

  let request = ""
  let sessionID: string | undefined
  let counter = 0
  let insert: InsertTranscript | undefined
  let done: StopOptions["done"]
  let settled: StopOptions["settled"]
  let ready: (() => boolean) | undefined
  let ownership: (() => () => boolean) | undefined
  let owned: (() => boolean) | undefined
  let retain: StartOptions["retain"]
  let check: StartOptions["check"]
  let settle: StartOptions["settle"]
  let result:
    | {
        text: string
        request: string
        save: StartOptions["retain"]
        abort: AbortController
        detached: boolean
        acknowledged: boolean
      }
    | undefined
  let pending = false
  let submitted = false
  const retired = new Map<string, { save: NonNullable<StartOptions["retain"]>; check: StartOptions["check"] }>()
  const capture = new SpeechCapture() // raya_change - Milestone H
  let local = false // raya_change - Milestone H
  let model = "" // raya_change - Milestone H
  let speech: (() => void) | undefined // raya_change - Milestone H extension-host VAD
  let failed: ((message: string) => void) | undefined
  let empty: (() => void) | undefined
  let silence: (() => void) | undefined // raya_change - Milestone H extension-host VAD
  let handsfree = false

  const unsub = vscode.onMessage((msg) => {
    if (!isSpeechMessage(msg)) return
    if (!request || msg.requestId !== request) {
      recover(msg)
      return
    }

    if (msg.type === "speechToTextStarted") {
      if (state() !== "starting") return
      setState("recording")
      if (pending) transcribe()
      return
    }

    // raya_change start - Milestone H extension-host VAD fallback
    if (msg.type === "speechToTextSpeech") {
      if (state() !== "recording") return
      if (!handsfree) vscode.postMessage({ type: "speechPlaybackCancel" })
      speech?.()
      return
    }
    if (msg.type === "speechToTextSilence") {
      if (state() !== "recording") return
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
      rejected(msg)
      return
    }

    if (check?.(msg.text, request) === false) {
      finalize(settled)
      cleanup()
      setState("idle")
      setError(undefined)
      return
    }
    const text = msg.text.trim()
    if (!text) {
      if (resume()) return
      fail(lang.t("speechToText.error.emptyTranscript"))
      return
    }

    finish(text)
  })

  onCleanup(() => {
    unsub()
    cancel()
    retired.clear()
  })

  function start(opts: StartOptions) {
    if (active()) return
    if (retired.size >= 16) {
      setState("error")
      setError("Earlier cancelled transcriptions remain unresolved. Reopen this view before recording again.")
      return
    }
    insert = opts.insert
    ownership = opts.ownership
    retain = opts.retain
    check = opts.check
    settle = opts.settle
    model = opts.model
    speech = opts.onSpeech
    silence = opts.onSilence
    handsfree = opts.handsFree === true
    failed = opts.onError
    empty = opts.handsFree ? opts.onEmpty : undefined
    setError(undefined)

    counter++
    request = `${prefix}-${counter}`
    const id = request
    sessionID = session()
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
            if (request !== id || state() !== "recording") return
            if (!opts.handsFree) vscode.postMessage({ type: "speechPlaybackCancel" })
            opts.onSpeech?.()
          },
          onSilence: () => {
            if (request === id && state() === "recording") opts.onSilence?.()
          },
        })
        .then(() => {
          if (request !== id) return
          if (state() === "starting") setState("recording")
          if (pending) transcribe()
        })
        .catch((err: unknown) => {
          if (request !== id || state() !== "starting") return
          console.warn("[Raya] Webview microphone unavailable; using extension-host capture:", err)
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
      ...(sessionID ? { sessionID } : {}),
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
    settled = opts?.settled
    ready = opts?.ready
    if (state() === "starting") {
      pending = true
      return
    }
    transcribe()
  }

  function transcribe() {
    pending = false
    owned = ownership?.()
    setState("transcribing")
    // raya_change start - send the actual webview recording to the configured STT endpoint
    if (local) {
      const id = request
      const origin = sessionID
      const selected = model
      void capture.stop().then(
        (audio) => {
          if (request !== id || state() !== "transcribing") return
          submitted = true
          vscode.postMessage({
            type: "speechToTextSubmit",
            requestId: id,
            ...(origin ? { sessionID: origin } : {}),
            model: selected,
            language: langCode(),
            format: audio.format,
            data: audio.data,
          })
        },
        (err: unknown) => {
          if (request === id) fail(err instanceof Error ? err.message : String(err))
        },
      )
      return
    }
    // raya_change end
    submitted = true
    vscode.postMessage({ type: "speechToTextStop", requestId: request, ...(sessionID ? { sessionID } : {}) })
  }

  function recover(
    msg: Extract<
      ExtensionMessage,
      {
        type:
          | "speechToTextResult"
          | "speechToTextStarted"
          | "speechToTextSpeech"
          | "speechToTextSilence"
          | "speechToTextCancelled"
          | "speechToTextError"
      }
    >,
  ) {
    const token = retired.get(msg.requestId)
    if (!token) return
    if (msg.type === "speechToTextCancelled" || msg.type === "speechToTextError") {
      retired.delete(msg.requestId)
      return
    }
    if (msg.type !== "speechToTextResult") return
    retired.delete(msg.requestId)
    try {
      if (token.check?.(msg.text, msg.requestId) === false) return
      if (msg.text.length > 262_144 || new TextEncoder().encode(msg.text).byteLength > 262_144) {
        console.warn("[Raya] Retired speech exceeded the detached recovery limit.")
        return
      }
      const text = msg.text.trim()
      if (text) token.save(text, msg.requestId)
    } catch {
      console.warn("[Raya] Retired recognized speech could not be retained.")
    }
  }

  function cancel() {
    if (submitted && request && !result && retain) retired.set(request, { save: retain, check })
    capture.cancel() // Retire retained hands-free streams even after transcription cleared local state.
    if (!local && request && active())
      vscode.postMessage({ type: "speechToTextCancel", requestId: request, ...(sessionID ? { sessionID } : {}) })
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

  function rejected(msg: Extract<ExtensionMessage, { type: "speechToTextError" }>) {
    if (msg.code === "empty_transcript" && resume()) return
    if (msg.code === "not_authenticated") {
      login()
      return
    }
    fail(msg.error)
  }

  function finish(text: string) {
    const token = { text, request, save: retain, abort: new AbortController(), detached: false, acknowledged: false }
    result = token
    request = ""
    void complete(token)
  }

  function authorized() {
    return (!ownership || !!owned) && owned?.() !== false
  }

  async function complete(token: NonNullable<typeof result>) {
    const release = settled
    let fault = false
    try {
      if (result !== token || token.abort.signal.aborted) return
      const wait = settle
      const accepted = wait ? await wait(token.abort.signal) : true
      if (result !== token) return
      if (!accepted) {
        cleanup()
        setState("idle")
        setError(undefined)
        return
      }
      const valid = authorized()
      if (result !== token) return
      if (!valid) {
        cleanup()
        setState("idle")
        setError(undefined)
        return
      }
      if (result !== token) return
      const next = ready?.() === false ? undefined : done
      if (result !== token) return
      const inserted = insert?.(token.text, () => {
        if (result === token) token.acknowledged = true
      })
      if (result !== token) return
      cleanup(false)
      setState("idle")
      setError(undefined)
      if (inserted !== false) await next?.() // Do not send a voice-mode command as a chat turn.
    } catch {
      fault = true
      // A callback can fail after a partial insertion. Preserve speech, never retry or send it here.
      if (result === token) {
        cleanup()
        detach(token)
        setState("idle")
        setError("Speech could not be applied safely. Review the retained transcript.")
        return
      }
      detach(token)
      console.warn("[Raya] Speech result consumption failed after retirement.")
    } finally {
      if (!fault) finalize(release)
    }
  }

  function finalize(release: StopOptions["settled"]) {
    try {
      release?.()
    } catch {
      console.warn("[Raya] Original speech turn release failed.")
    }
  }

  function fail(message: string, toast = true) {
    const notify = failed
    capture.cancel()
    cleanup()
    setState("error")
    setError(message)
    notify?.(message)
    if (toast) showToast({ variant: "error", title: lang.t("speechToText.error.title"), description: message })
  }

  function resume() {
    if (!empty) return false
    const next = empty
    const release = settled
    cleanup()
    finalize(release)
    setState("idle")
    setError(undefined)
    next()
    return true
  }

  function detach(token: NonNullable<typeof result>) {
    if (token.detached) return
    token.detached = true
    try {
      token.save?.(token.text, token.request)
    } catch {
      console.warn("[Raya] Recognized speech could not be retained.")
    }
  }

  function cleanup(preserve = true) {
    const token = result
    result = undefined
    token?.abort.abort()
    if (token && preserve && !token.acknowledged) detach(token)
    request = ""
    sessionID = undefined
    insert = undefined
    done = undefined
    settled = undefined
    ready = undefined
    ownership = undefined
    owned = undefined
    retain = undefined
    check = undefined
    settle = undefined
    pending = false
    submitted = false
    local = false // raya_change - Milestone H
    model = "" // raya_change - Milestone H
    speech = undefined // raya_change - Milestone H
    silence = undefined
    failed = undefined // raya_change - Milestone H
    empty = undefined
  }

  return {
    state,
    error,
    active,
    start,
    stop,
    rejectEcho: () => capture.rejectEcho(),
    suspend: () => capture.suspend(),
    cancel,
    clear,
  }
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
