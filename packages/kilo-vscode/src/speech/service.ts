// raya_change - Milestone H extension-owned speech orchestration
import type * as vscode from "vscode"
import { MiniMaxTts } from "./minimax-tts"
import { transcribe } from "./openai-stt"
import { SpeechSettingsStore, type SpeechSettings } from "./settings"
import { VoiceReplies } from "./replies"
import { getErrorMessage } from "../kilo-provider-utils"
import { cancelSpeechCapture, startSpeechCapture, stopSpeechCapture, startLiveCapture, stopLiveCapture, cancelLiveCapture } from "../speech-to-text/capture" // raya_change - native fallback when VS Code denies webview mic access
import type { KiloConnectionService } from "../services/cli-backend/connection-service" // raya_change - realtime voice session broker
import { RealtimeBroker } from "./realtime-broker"
import { voiceFallback } from "./fallback" // raya_change - explicit three-rung degradation
import { LiveBroker } from "./live-broker"
import { OpenAIBroker } from "./openai-broker"
import { loadVoiceContext } from "./openai-context"
import type { SpeechKey } from "../shared/speech"

type Post = (message: unknown) => void

export class SpeechService implements vscode.Disposable {
  readonly settings: SpeechSettingsStore
  private readonly tts = new MiniMaxTts()
  private readonly aborts = new Map<string, AbortController>()
  private readonly replies = new VoiceReplies() // raya_change - extension-host voice reply handoff
  private readonly realtime: RealtimeBroker
  private readonly openai: OpenAIBroker
  private readonly live: LiveBroker
  private closed = false
  private tail: Promise<void> = Promise.resolve()

  constructor(
    context: vscode.ExtensionContext,
    opts?: { live?: LiveBroker; openai?: OpenAIBroker; realtime?: RealtimeBroker },
  ) {
    this.settings = new SpeechSettingsStore(context.globalState, context.secrets)
    this.live = opts?.live ?? new LiveBroker()
    this.openai = opts?.openai ?? new OpenAIBroker()
    this.realtime = opts?.realtime ?? new RealtimeBroker()
  }

  private enqueue(work: () => Promise<void>) {
    const next = this.tail.then(work, work)
    this.tail = next.then(
      () => {},
      (err) => {
        console.error("[Raya] Voice cleanup failed; resource release is unconfirmed.", err)
      },
    )
    return next
  }

  private async release() {
    await cancelLiveCapture()
    await Promise.all([this.live.stop(), this.openai.stop(), this.realtime.stop()])
  }

  drop() {
    void this.enqueue(() => this.release())
  }

  private async admit(failed: (error: string) => void) {
    if (this.closed) {
      failed("Voice is closed.")
      return false
    }
    await this.tail
    if (this.closed) {
      failed("Voice is closed.")
      return false
    }
    return true
  }

  ended() {
    return this.tail
  }

  async state(post: Post): Promise<void> {
    post({ type: "speechSettingsLoaded", settings: await this.settings.load() })
  }

  async update(input: Partial<SpeechSettings>, root: string, post: Post): Promise<void> {
    if (input.voiceEngine !== undefined) {
      await this.enqueue(async () => {
        const prior = await this.settings.load()
        if (input.voiceEngine !== prior.voiceEngine) await this.release()
        await this.settings.update(input)
      })
    } else {
      await this.settings.update(input)
    }
    const settings = await this.settings.load()
    await this.settings.sync(root)
    post({ type: "speechSettingsLoaded", settings })
  }

  async key(kind: SpeechKey, value: string | undefined, root: string, post: Post): Promise<void> {
    const settings = await this.settings.setKey(kind, value)
    await this.settings.sync(root)
    post({ type: "speechSettingsLoaded", settings })
  }

  // raya_change start - extension-host broker keeps Qwen and LiveKit service credentials out of the webview
  async realtimeStart(
    input: { sessionID: string; directory: string; connection: KiloConnectionService },
    post: Post,
  ): Promise<void> {
    const failed = (error: string) =>
      post({ type: "speechRealtimeError", code: "busy", error })
    if (!(await this.admit(failed))) return
    if (this.openai.active || this.live.active || this.realtime.active) {
      failed("End the existing OpenAI voice call before switching engines.")
      return
    }
    const result = await this.realtime.start(
      async () => {
        const settings = await this.settings.load()
        const fallback = voiceFallback(settings)
        if (settings.voiceEngine !== "qwen-realtime") {
          return {
            ok: false,
            code: "configuration",
            error: "Native realtime voice is disabled in Speech settings.",
            fallback,
          }
        }
        const key = await this.settings.key("realtime")
        if (!key) {
          return { ok: false, code: "configuration", error: "Add the Qwen realtime key in Speech settings.", fallback }
        }
        await input.connection.getClientAsync(input.directory)
        const server = input.connection.getServerConfig()
        if (!server) throw new Error("Raya backend is not connected")
        return {
          sessionID: input.sessionID,
          directory: input.directory,
          backendURL: server.baseUrl,
          auth: `Basic ${Buffer.from(`kilo:${server.password}`).toString("base64")}`,
          key,
          settings,
        }
      },
      (info) =>
        post({
          type: "speechRealtimeReady",
          connection: {
            id: info.id,
            livekitURL: info.livekitURL,
            clientToken: info.clientToken,
            engine: info.engine,
            acceptsTruncation: info.acceptsTruncation,
          },
        }),
    )
    if (!result.ok && result.code !== "cancelled")
      post({ type: "speechRealtimeError", error: result.error, code: result.code, fallback: result.fallback })
  }

  async realtimeStop(post: Post): Promise<void> {
    this.replies.cancel()
    const failure = await this.realtime.stop()
    if (failure) {
      post({ type: "speechRealtimeError", error: failure.error, code: failure.code })
      return
    }
    post({ type: "speechRealtimeStopped" })
  }

  async openaiStart(
    input: {
      requestId: string
      engine?: "live"
      sessionID: string
      sdp: string
      directory: string
      connection: KiloConnectionService
      current: () => boolean
    },
    post: Post,
  ) {
    if (input.engine === "live") return this.liveStart(input, post)
    const failed = (error: string) => post({ type: "speechOpenAIError", requestId: input.requestId, error })
    if (!(await this.admit(failed))) return
    if (this.realtime.active || this.live.active || this.openai.active) {
      failed("End the existing voice call before switching to OpenAI.")
      return
    }
    await this.openai.start(
      { requestID: input.requestId, sessionID: input.sessionID, sdp: input.sdp },
      async (signal) => {
        const settings = await this.settings.load()
        if (settings.voiceEngine !== "openai-realtime")
          throw new Error("OpenAI voice is not selected in Speech settings.")
        const key = await this.settings.key("openai")
        if (!key) throw new Error("OpenAI voice requires its own API key in Speech settings.")
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(settings.openaiVoice)) throw new Error("OpenAI voice name is invalid.")
        const client = await input.connection.getClientAsync(input.directory)
        const server = input.connection.getServerConfig()
        if (!server || !input.current()) throw new Error("The voice connection or workspace changed.")
        const current = () => input.current() && input.connection.getServerConfig() === server
        const context = await loadVoiceContext(client, input.sessionID, input.directory, signal, current)
        if (!current()) throw new Error("The voice connection or workspace changed.")
        return {
          key,
          voice: settings.openaiVoice,
          backend: server.baseUrl,
          authorization: `Basic ${Buffer.from(`kilo:${server.password}`).toString("base64")}`,
          directory: input.directory,
          current,
          context: context.text,
          usage: (usage) =>
            post({ type: "speechOpenAIUsage", requestId: input.requestId, sessionID: input.sessionID, usage }),
        }
      },
      (sdp) => post({ type: "speechOpenAIReady", requestId: input.requestId, sdp }),
      failed,
    )
  }

  private async liveStart(input: Parameters<SpeechService["openaiStart"]>[0], post: Post): Promise<void> {
    const failed = (error: string) => post({ type: "speechOpenAIError", requestId: input.requestId, error })
    if (!(await this.admit(failed))) return
    if (this.realtime.active || this.openai.active || this.live.active) {
      failed("End the existing voice call before switching to GPT-Live.")
      return
    }
    const settings = await this.settings.load()
    if (settings.voiceEngine !== "openai-live") {
      failed("GPT-Live voice is not selected in Speech settings.")
      return
    }
    if (!(await this.settings.key("openai"))) {
      failed("GPT-Live requires an OpenAI API key in Speech settings.")
      return
    }
    if (this.closed || this.realtime.active || this.openai.active || this.live.active) {
      failed(this.closed ? "Voice is closed." : "End the existing voice call before switching to GPT-Live.")
      return
    }
    await this.live.start(
      { requestID: input.requestId, sessionID: input.sessionID, sdp: input.sdp },
      async (signal) => {
        const settings = await this.settings.load()
        if (settings.voiceEngine !== "openai-live") throw new Error("GPT-Live voice is not selected in Speech settings.")
        const key = await this.settings.key("openai")
        if (!key) throw new Error("GPT-Live requires an OpenAI API key in Speech settings.")
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(settings.openaiVoice)) throw new Error("OpenAI voice name is invalid.")
        const client = await input.connection.getClientAsync(input.directory)
        const server = input.connection.getServerConfig()
        if (!server || !input.current()) throw new Error("The voice connection or workspace changed.")
        const current = () => input.current() && input.connection.getServerConfig() === server
        const context = await loadVoiceContext(client, input.sessionID, input.directory, signal, current)
        if (!current()) throw new Error("The voice connection or workspace changed.")
        return {
          key, voice: settings.openaiVoice, backend: server.baseUrl,
          authorization: `Basic ${Buffer.from(`kilo:${server.password}`).toString("base64")}`,
          directory: input.directory, current, context: context.text,
          started: () => post({ type: "speechLiveStarted", requestId: input.requestId }),
          usage: (usage) => post({ type: "speechLiveUsage", requestId: input.requestId, sessionID: input.sessionID, usage }),
        }
      },
      (answer) => post({ type: "speechOpenAIReady", requestId: input.requestId, sdp: answer.sdp }),
      failed,
    )
  }

  async liveMicStart(requestId: string, post: Post): Promise<void> {
    const failed = (error: string) => post({ type: "speechLiveMicError", requestId, error })
    if (!(await this.admit(failed))) return
    const settings = await this.settings.load()
    if (settings.voiceEngine !== "openai-live" || !this.live.owned(requestId)) {
      failed("Live microphone capture is not available for this call.")
      return
    }
    try {
      await startLiveCapture(requestId, (buf) => {
        post({ type: "speechLiveMicChunk", requestId, data: buf.toString("base64") })
      })
      post({ type: "speechLiveMicReady", requestId })
    } catch (err) {
      post({ type: "speechLiveMicError", requestId, error: getErrorMessage(err) })
    }
  }

  async liveMicStop(requestId: string): Promise<void> {
    await stopLiveCapture(requestId)
  }

  async liveControl(requestId: string, eventID: string, action: "mute" | "unmute" | "stop_speaking", post: Post) {
    const result = await this.live.control(requestId, eventID, action)
    post({ type: "speechLiveControlResult", requestId, eventID, ...result })
  }

  async openaiImage(requestId: string, imageID: string, data: string, post: Post) {
    const result = this.live.active
      ? await this.live.share(requestId, imageID, data)
      : await this.openai.share(requestId, imageID, data)
    post({ type: "speechOpenAIImageResult", requestId, imageID, ...result })
  }

  openaiInterrupt(requestId: string, responseID: string, eventID: string) {
    this.openai.interrupt(requestId, responseID, eventID)
  }

  async openaiStop(requestId: string, post: Post) {
    await stopLiveCapture(requestId)
    const errors = await Promise.all([this.openai.stop(requestId), this.live.stop(requestId)])
    const error = errors.find((value) => value !== undefined)
    post(error ? { type: "speechOpenAIError", requestId, error } : { type: "speechOpenAIStopped", requestId })
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
    post({
      type: "speechToTextError",
      requestId: input.requestId,
      error: result.error,
      code: result.code,
    })
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
    if (settings.mode === "off" || ["openai-realtime", "openai-live"].includes(settings.voiceEngine) || this.openai.active || this.live.active) return
    await this.speak({ requestId: crypto.randomUUID(), text: speakable(text) }, post)
  }
  // raya_change end

  cancel(requestId?: string): void {
    if (requestId) this.aborts.get(requestId)?.abort()
    if (requestId) void cancelSpeechCapture(requestId) // raya_change - extension-host microphone fallback
    if (requestId) void stopLiveCapture(requestId)
    if (!requestId) {
      for (const ctrl of this.aborts.values()) ctrl.abort()
      this.aborts.clear()
    }
    this.tts.cancel(requestId)
  }

  dispose(): void {
    this.closed = true
    this.cancel()
    void cancelLiveCapture()
    void this.enqueue(async () => {
      const live = await this.live.dispose()
      if (live) console.error("[Raya] Live voice disposal failed; resource release is unconfirmed.")
      const openai = await this.openai.dispose()
      if (openai) console.error("[Raya] OpenAI voice disposal failed:", openai)
      const realtime = await this.realtime.dispose()
      if (realtime) console.error("[Kilo New] Voice disposal failed:", realtime.error)
      this.tts.dispose()
    })
  }
}

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
