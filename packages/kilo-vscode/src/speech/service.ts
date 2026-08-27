// raya_change - Milestone H extension-owned speech orchestration
import type * as vscode from "vscode"
import { MiniMaxTts } from "./minimax-tts"
import { transcribe } from "./openai-stt"
import { SpeechSettingsStore, type SpeechSettings } from "./settings"
import { VoiceReplies } from "./replies"
import { getErrorMessage } from "../kilo-provider-utils"
import { cancelSpeechCapture, startSpeechCapture, stopSpeechCapture } from "../speech-to-text/capture" // raya_change - native fallback when VS Code denies webview mic access
import type { KiloConnectionService } from "../services/cli-backend/connection-service" // raya_change - realtime voice session broker
import { voiceFallback } from "./fallback" // raya_change - explicit three-rung degradation

type Post = (message: unknown) => void
type RealtimeSession = {
  id: string
  room: string
  livekitURL: string
  clientToken: string
  mediaToken: string
  engine: "qwen-realtime"
  acceptsTruncation: boolean
}

export class SpeechService implements vscode.Disposable {
  readonly settings: SpeechSettingsStore
  private readonly tts = new MiniMaxTts()
  private readonly aborts = new Map<string, AbortController>()
  private readonly replies = new VoiceReplies() // raya_change - extension-host voice reply handoff
  private realtime:
    | { info: RealtimeSession; mediaURL: string; backendURL: string; auth: string; directory: string }
    | undefined // raya_change - provider secrets remain extension-host only

  constructor(context: vscode.ExtensionContext) {
    this.settings = new SpeechSettingsStore(context.globalState, context.secrets)
  }

  async state(post: Post): Promise<void> {
    post({ type: "speechSettingsLoaded", settings: await this.settings.load() })
  }

  async update(input: Partial<SpeechSettings>, root: string, post: Post): Promise<void> {
    const settings = await this.settings.update(input)
    await this.settings.sync(root)
    post({ type: "speechSettingsLoaded", settings })
  }

  async key(kind: "realtime" | "stt" | "tts", value: string | undefined, root: string, post: Post): Promise<void> {
    const settings = await this.settings.setKey(kind, value)
    await this.settings.sync(root)
    post({ type: "speechSettingsLoaded", settings })
  }

  // raya_change start - extension-host broker keeps Qwen and LiveKit service credentials out of the webview
  async realtimeStart(
    input: { sessionID: string; directory: string; connection: KiloConnectionService },
    post: Post,
  ): Promise<void> {
    await this.realtimeStop(() => undefined)
    const settings = await this.settings.load()
    const fallback = voiceFallback(settings)
    if (settings.voiceEngine !== "qwen-realtime") {
      post({ type: "speechRealtimeError", error: "Native realtime voice is disabled in Speech settings.", fallback })
      return
    }
    const key = await this.settings.key("realtime")
    if (!key) {
      post({ type: "speechRealtimeError", error: "Add the Qwen realtime key in Speech settings.", fallback })
      return
    }
    const result = await startRealtime(input, settings, key)
    if (!result.ok) {
      post({ type: "speechRealtimeError", error: result.error, fallback })
      return
    }
    this.realtime = result.value
    post({
      type: "speechRealtimeReady",
      connection: {
        id: result.value.info.id,
        livekitURL: result.value.info.livekitURL,
        clientToken: result.value.info.clientToken,
        engine: result.value.info.engine,
        acceptsTruncation: result.value.info.acceptsTruncation,
      },
    })
  }

  async realtimeStop(post: Post): Promise<void> {
    const current = this.realtime
    this.realtime = undefined
    this.replies.cancel() // raya_change - stopping the orb also cancels any pending MiniMax handoff
    if (current) {
      const query = `?directory=${encodeURIComponent(current.directory)}`
      await Promise.allSettled([
        fetch(`${current.mediaURL.replace(/\/$/, "")}/v1/sessions/${current.info.id}`, { method: "DELETE" }),
        fetch(`${current.backendURL}/kilocode/voice/session/${current.info.id}${query}`, {
          method: "DELETE",
          headers: { Authorization: current.auth },
        }),
      ])
    }
    post({ type: "speechRealtimeStopped" })
  }
  // raya_change end

  async transcribe(
    input: { requestId: string; data: string; format: string; model?: string; language?: string },
    post: Post,
  ): Promise<void> {
    const settings = await this.settings.load()
    const key = (await this.settings.key("stt")) ?? ""
    const ctrl = new AbortController()
    this.aborts.set(input.requestId, ctrl)
    const result = await transcribe(
      {
        endpoint: settings.sttEndpoint,
        key,
        model: input.model || settings.sttModel,
        data: input.data,
        format: input.format,
        language: input.language,
      },
      ctrl.signal,
    )
    this.aborts.delete(input.requestId)
    if (result.ok) {
      post({ type: "speechToTextResult", requestId: input.requestId, text: result.text })
      return
    }
    if (result.code === "cancelled") {
      post({ type: "speechToTextCancelled", requestId: input.requestId })
      return
    }
    post({ type: "speechToTextError", requestId: input.requestId, error: result.error, code: result.code })
  }

  // raya_change start - configured STT through extension-host capture and VAD
  async configured(): Promise<boolean> {
    const settings = await this.settings.load()
    return !!settings.sttEndpoint && !!(await this.settings.key("stt"))
  }

  async captureStart(
    input: {
      requestId: string
      model?: string
      language?: string
      handsFree?: boolean
      threshold?: number
      silenceMs?: number
    },
    post: Post,
  ): Promise<void> {
    const settings = await this.settings.load()
    try {
      const started = await startSpeechCapture({
        requestId: input.requestId,
        model: input.model || settings.sttModel,
        language: input.language,
        handsFree: input.handsFree,
        threshold: input.threshold,
        silenceMs: input.silenceMs,
        onSpeech: () => post({ type: "speechToTextSpeech", requestId: input.requestId }),
        onSilence: () => post({ type: "speechToTextSilence", requestId: input.requestId }),
      })
      if (started) post({ type: "speechToTextStarted", requestId: input.requestId })
    } catch (err) {
      post({ type: "speechToTextError", requestId: input.requestId, error: getErrorMessage(err) })
    }
  }

  async captureStop(input: { requestId: string; language?: string }, post: Post): Promise<void> {
    try {
      const audio = await stopSpeechCapture(input.requestId)
      await this.transcribe({ requestId: input.requestId, language: input.language, ...audio }, post)
    } catch (err) {
      post({ type: "speechToTextError", requestId: input.requestId, error: getErrorMessage(err) })
    }
  }

  captureCancel(requestId: string, post: Post): void {
    void cancelSpeechCapture(requestId).then(() => post({ type: "speechToTextCancelled", requestId }))
  }
  // raya_change end

  async speak(input: { requestId: string; text: string }, post: Post): Promise<void> {
    const settings = await this.settings.load()
    const key = await this.settings.key("tts")
    if (!key) {
      post({
        type: "speechPlaybackError",
        requestId: input.requestId,
        error: "Add the MiniMax TTS key in Speech settings.",
      })
      return
    }
    const stream = { started: false } // raya_change - send echo reference once without duplicating text on every chunk
    this.tts.speak(
      {
        id: input.requestId,
        endpoint: settings.ttsEndpoint,
        key,
        model: settings.ttsModel,
        voice: settings.voice,
        text: input.text.slice(0, 10_000),
      },
      {
        chunk: (data, mime) => {
          post({
            type: "speechPlaybackChunk",
            requestId: input.requestId,
            data,
            mime,
            text: stream.started ? undefined : input.text,
          })
          stream.started = true
        },
        done: (result) => post({ type: "speechPlaybackDone", requestId: input.requestId, ...result }),
        error: (error) => post({ type: "speechPlaybackError", requestId: input.requestId, error }),
      },
    )
  }

  // raya_change start - authoritative backend-event handoff from Voice response to MiniMax
  markVoiceTurn(): void {
    this.replies.mark()
  }

  trackMessage(sessionID: string, role: string, messageID: string): void {
    this.replies.message(sessionID, role, messageID)
  }

  trackPart(
    sessionID: string,
    part: { id: string; messageID?: string; type: string; text?: string; synthetic?: boolean },
  ): void {
    this.replies.part(sessionID, part)
  }

  removePart(sessionID: string, partID: string): void {
    this.replies.remove(sessionID, partID)
  }

  async speakOnIdle(sessionID: string, post: Post): Promise<void> {
    const text = await this.replies.wait(sessionID)
    if (!text) return
    const settings = await this.settings.load()
    if (settings.mode === "off") return
    await this.speak({ requestId: crypto.randomUUID(), text: speakable(text) }, post)
  }
  // raya_change end

  cancel(requestId?: string): void {
    if (requestId) this.aborts.get(requestId)?.abort()
    if (requestId) void cancelSpeechCapture(requestId) // raya_change - extension-host microphone fallback
    if (!requestId) {
      for (const ctrl of this.aborts.values()) ctrl.abort()
      this.aborts.clear()
    }
    this.tts.cancel(requestId)
  }

  dispose(): void {
    this.cancel()
    void this.realtimeStop(() => undefined) // raya_change - close media and backend sessions on extension disposal
    this.tts.dispose()
  }
}

// raya_change start - ordered backend admission followed by secret-bearing local media admission
async function startRealtime(
  input: { sessionID: string; directory: string; connection: KiloConnectionService },
  settings: SpeechSettings,
  key: string,
): Promise<
  | {
      ok: true
      value: { info: RealtimeSession; mediaURL: string; backendURL: string; auth: string; directory: string }
    }
  | { ok: false; error: string }
> {
  try {
    await input.connection.getClientAsync(input.directory)
    const server = input.connection.getServerConfig()
    if (!server) return { ok: false, error: "Raya backend is not connected." }
    const auth = `Basic ${Buffer.from(`kilo:${server.password}`).toString("base64")}`
    const query = `?directory=${encodeURIComponent(input.directory)}`
    const mediaURL = settings.mediaFrontendURL.replace(/\/$/, "")
    const started = await fetch(`${server.baseUrl}/kilocode/voice/session${query}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ parentSessionID: input.sessionID, mediaURL }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!started.ok) return { ok: false, error: `Voice session admission failed (${started.status}).` }
    const info = (await started.json()) as RealtimeSession
    const media = await fetch(`${mediaURL}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: info.id,
        room: info.room,
        livekitUrl: info.livekitURL,
        livekitToken: info.mediaToken,
        backendUrl: server.baseUrl,
        backendAuthorization: auth,
        directory: input.directory,
        engine: {
          endpoint: settings.realtimeEndpoint,
          key,
          model: settings.realtimeModel,
          voice: settings.realtimeVoice,
          instructions:
            "You are Raya Voice. Be concise and conversational. Use delegate for grounded workspace facts or read-only actions.",
          mode: "hands-free",
          threshold: settings.vadThreshold,
          silence: settings.vadSilenceMs * 1_000_000,
        },
      }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!media.ok) {
      await fetch(`${server.baseUrl}/kilocode/voice/session/${info.id}${query}`, {
        method: "DELETE",
        headers: { Authorization: auth },
      })
      return { ok: false, error: `Realtime media frontend failed (${media.status}).` }
    }
    return { ok: true, value: { info, mediaURL, backendURL: server.baseUrl, auth, directory: input.directory } }
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) }
  }
}
// raya_change end

function speakable(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^[#>*+-]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
}
