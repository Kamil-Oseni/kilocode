// raya_change - Milestone H extension-owned speech orchestration
import type * as vscode from "vscode"
import { MiniMaxTts } from "./minimax-tts"
import { LocalTts } from "./local-tts"
import { transcribe } from "./openai-stt"
import { SpeechSettingsStore, type SpeechSettings } from "./settings"
import { VoiceReplies } from "./replies"
import { diagnostics, type PlaybackDiagnostic } from "./diagnostics"
import { getErrorMessage } from "../kilo-provider-utils"
import {
  cancelSpeechCapture,
  startSpeechCapture,
  stopSpeechCapture,
  startLiveCapture,
  stopLiveCapture,
  cancelLiveCapture,
} from "../speech-to-text/capture" // raya_change - native fallback when VS Code denies webview mic access
import type { KiloConnectionService } from "../services/cli-backend/connection-service" // raya_change - realtime voice session broker
import { RealtimeBroker } from "./realtime-broker"
import { voiceFallback } from "./fallback" // raya_change - explicit three-rung degradation
import { LiveBroker } from "./live-broker"
import { OpenAIBroker } from "./openai-broker"
import { loadVoiceContext } from "./openai-context"
import type { SpeechKey } from "../shared/speech"
import type { AdminVoiceSignal } from "../shared/admin"
import { valid, quiet, type Handoff, type HandoffQuiet } from "../shared/voice-handoff"

type Post = (message: unknown) => void
const healthKey = "raya.voice.health.v1"
type Health = "ready" | "failed" | "incomplete"

export class SpeechService implements vscode.Disposable {
  readonly settings: SpeechSettingsStore
  private readonly tts = new MiniMaxTts()
  private readonly localtts: LocalTts
  private readonly diagnostic?: (row: PlaybackDiagnostic) => void
  private readonly aborts = new Map<string, AbortController>()
  private readonly replies: VoiceReplies // raya_change - extension-host voice reply handoff
  private readonly realtime: RealtimeBroker
  private readonly openai: OpenAIBroker
  private readonly live: LiveBroker
  private readonly store: vscode.Memento
  private closed = false
  private request: string | undefined
  private warm:
    | { request: string; alive: boolean; timer?: ReturnType<typeof setTimeout>; done: Promise<void> }
    | undefined
  private readonly interval: number
  private waiting: string | undefined
  private closing: Promise<boolean> | undefined
  private retiring: string | undefined
  private health: Health
  private healthTail: Promise<void> = Promise.resolve()
  private tail: Promise<void> = Promise.resolve()

  constructor(
    context: vscode.ExtensionContext,
    opts?: {
      live?: LiveBroker
      openai?: OpenAIBroker
      realtime?: RealtimeBroker
      diagnostic?: (row: PlaybackDiagnostic) => void
      refresh?: number
    },
  ) {
    this.interval = opts?.refresh ?? 60_000
    if (!Number.isInteger(this.interval) || this.interval < 1 || this.interval > 60_000)
      throw new Error("Invalid local speech readiness interval.")
    this.store = context.globalState
    this.health = loadHealth(this.store.get<unknown>(healthKey))
    this.settings = new SpeechSettingsStore(context.globalState, context.secrets)
    this.diagnostic = opts?.diagnostic
    this.replies = new VoiceReplies(opts?.diagnostic)
    this.localtts = new LocalTts({ diagnostic: opts?.diagnostic })
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
    const request = this.request
    this.retiring = request
    const warm = this.warm
    this.cancel()
    const results = await Promise.allSettled([
      this.localtts.cancel(),
      warm?.done,
      cancelLiveCapture(),
      this.live.stop(),
      this.openai.stop(),
      this.realtime.stop(),
    ])
    const failed = results.some((result) => result.status === "rejected" || !!result.value)
    for (const result of results) {
      if (result.status === "rejected") console.error("[Raya] Voice resource release failed.", result.reason)
      if (result.status === "fulfilled" && result.value)
        console.error("[Raya] Voice resource release is unconfirmed.", result.value)
    }
    if (this.warm === warm) this.warm = undefined
    if (!failed && this.request === request) this.request = undefined
    if (failed) this.incomplete()
    return !failed
  }

  drop() {
    this.replies.cancel()
    this.cancel()
    void this.enqueue(async () => {
      await this.release()
    })
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

  async ended() {
    await this.tail
    await this.healthTail
  }

  admin(): AdminVoiceSignal {
    return {
      available: !this.closed,
      active: [this.live.active, this.openai.active, this.realtime.active, this.warm?.alive].filter(Boolean).length,
      failed: Number(this.health === "failed"),
      incomplete: Number(this.health === "incomplete"),
    }
  }

  private record(health: Health) {
    if (this.health === health) return
    this.health = health
    const saved = { format: "raya.voice-health", version: 1, status: health }
    this.healthTail = this.healthTail
      .then(() => this.store.update(healthKey, saved))
      .catch(() => {
        if (this.health === "ready") this.health = "incomplete"
      })
  }

  private healthy() {
    this.record("ready")
  }

  private failed() {
    this.record("failed")
  }

  private incomplete() {
    this.record("incomplete")
  }

  private degrade(code: string) {
    if (code === "admission_unknown" || code === "cleanup_failed") {
      this.incomplete()
      return
    }
    this.failed()
  }

  async state(post: Post): Promise<void> {
    post({ type: "speechSettingsLoaded", settings: await this.settings.load() })
  }

  async update(input: Partial<SpeechSettings>, root: string, post: Post): Promise<void> {
    if (input.voiceEngine !== undefined) {
      await this.enqueue(async () => {
        const prior = await this.settings.load()
        if (input.voiceEngine !== prior.voiceEngine && !(await this.release()))
          throw new Error("Voice cleanup is unconfirmed; the engine was not changed.")
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

  async local(root: string, post: Post): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed) throw new Error("Voice is closed.")
      if (!(await this.release())) throw new Error("Voice cleanup is unconfirmed; local setup was not applied.")
      this.replies.cancel()
      this.cancel()
      await this.localtts.cancel()
      const settings = await this.settings.local()
      await this.settings.sync(root)
      post({ type: "speechSettingsLoaded", settings })
    })
  }

  private async resume(request: string, post: Post) {
    if (!this.request) {
      this.request = request
      return true
    }
    if (!this.closing || this.waiting) {
      post({
        type: "speechRealtimeError",
        requestId: request,
        code: "busy",
        error: "End the previous local voice session and wait for cleanup before restarting.",
      })
      return false
    }
    this.waiting = request
    const joined = await this.closing
    if (this.waiting !== request) return false
    this.waiting = undefined
    if (!joined || this.closed) {
      post({
        type: "speechRealtimeError",
        requestId: request,
        code: "cleanup_failed",
        error: "Previous local voice cleanup is unconfirmed. Restart Raya before reconnecting.",
      })
      return false
    }
    this.request = request
    return true
  }

  // raya_change start - extension-host broker keeps Qwen and LiveKit service credentials out of the webview
  async realtimeStart(
    input: {
      requestId: string
      sessionID: string
      directory: string
      connection: KiloConnectionService
      current?: () => boolean
    },
    post: Post,
  ): Promise<void> {
    if (!(await this.resume(input.requestId, post)) || this.request !== input.requestId) return
    const current = () => this.request === input.requestId && this.retiring !== input.requestId && !this.closed
    const failed = (error: string) => {
      if (!current()) return
      this.failed()
      post({ type: "speechRealtimeError", requestId: input.requestId, code: "busy", error })
    }
    if (!(await this.admit(failed))) {
      if (current()) this.request = undefined
      return
    }
    if (!current()) return
    if (this.openai.active || this.live.active || this.realtime.active) {
      post({
        type: "speechRealtimeError",
        requestId: input.requestId,
        code: "busy",
        error: "End the existing OpenAI voice call before switching engines.",
      })
      if (current()) this.request = undefined
      return
    }
    const state: { settings?: SpeechSettings } = {}
    const result = await this.realtime.start(
      async () => {
        const settings = await this.settings.load()
        const fallback = voiceFallback(settings)
        if (settings.voiceEngine === "cascade-v1" && settings.ttsEngine === "local-jobs") {
          await this.prepare(input, settings, current)
          state.settings = settings
        }
        if (settings.voiceEngine !== "qwen-realtime" && settings.voiceEngine !== "openai-live") {
          return {
            ok: false,
            code: "configuration",
            error: "Native realtime voice is disabled in Speech settings.",
            fallback,
          }
        }
        if (settings.voiceEngine === "openai-live" && !input.current?.()) {
          return { ok: false, code: "configuration", error: "Reopen the original task before starting voice." }
        }
        const key = await this.settings.key(settings.voiceEngine === "openai-live" ? "openai" : "realtime")
        if (!key) {
          return {
            ok: false,
            code: "configuration",
            error: "Add the selected voice provider's key in Speech settings.",
            fallback,
          }
        }
        const mediaKey = process.env.RAYA_MF_TOKEN?.trim()
        if (!mediaKey || !/^[A-Za-z0-9_-]{43}$/.test(mediaKey)) {
          return {
            ok: false,
            code: "configuration",
            error: "Set RAYA_MF_TOKEN to the same 32-byte base64url key used by the media service.",
            fallback,
          }
        }
        const client = await input.connection.getClientAsync(input.directory)
        const server = input.connection.getServerConfig()
        if (!server) throw new Error("Raya backend is not connected")
        const selected = () => current() && (input.current?.() ?? true) && input.connection.getServerConfig() === server
        if (!selected()) throw new Error("The voice connection or workspace changed.")
        const context =
          settings.voiceEngine === "openai-live"
            ? await loadVoiceContext(client, input.sessionID, input.directory, AbortSignal.timeout(15_000), selected)
            : undefined
        if (!selected()) throw new Error("The voice connection or workspace changed.")
        return {
          sessionID: input.sessionID,
          directory: input.directory,
          backendURL: server.baseUrl,
          auth: `Basic ${Buffer.from(`kilo:${server.password}`).toString("base64")}`,
          key,
          mediaKey,
          settings,
          current: selected,
          context: context?.text,
        }
      },
      (info) => {
        if (!current()) return
        this.healthy()
        post({
          type: "speechRealtimeReady",
          requestId: input.requestId,
          connection: {
            id: info.id,
            livekitURL: info.livekitURL,
            clientToken: info.clientToken,
            engine: info.engine,
            acceptsTruncation: info.acceptsTruncation,
          },
        })
      },
    )
    this.admitted(input, result, state.settings, current, post)
  }

  private admitted(
    input: Parameters<SpeechService["realtimeStart"]>[0],
    result: Awaited<ReturnType<RealtimeBroker["start"]>>,
    settings: SpeechSettings | undefined,
    current: () => boolean,
    post: Post,
  ) {
    const cascade = !result.ok && result.code !== "cancelled" && result.fallback === "cascade-v1"
    if (current() && !result.ok && result.code !== "cancelled") {
      if (cascade && settings) this.healthy()
      if (!cascade || !settings) this.degrade(result.code)
      post({
        type: "speechRealtimeError",
        requestId: input.requestId,
        error: result.error,
        code: result.code,
        fallback: result.fallback,
      })
    }
    if (current() && cascade && settings) this.retain(input, current, post)
    if (current() && !this.realtime.active && !cascade) this.request = undefined
  }

  private retain(input: Parameters<SpeechService["realtimeStart"]>[0], current: () => boolean, post: Post) {
    const state: NonNullable<SpeechService["warm"]> = { request: input.requestId, alive: true, done: Promise.resolve() }
    this.warm = state
    const selected = () => state.alive && this.warm === state && current() && input.current?.() === true
    const schedule = () => {
      if (!selected()) {
        if (this.warm === state) this.warm = undefined
        return
      }
      state.timer = setTimeout(() => {
        state.timer = undefined
        state.done = (async () => {
          if (!selected()) return
          const settings = await this.settings.load()
          if (!selected()) return
          if (settings.voiceEngine !== "cascade-v1" || settings.ttsEngine !== "local-jobs") {
            if (this.warm === state) this.warm = undefined
            return
          }
          await this.prepare(input, settings, selected)
        })().then(schedule, (err) => {
          const active = selected()
          if (this.warm === state) this.warm = undefined
          if (!active) return
          this.degrade("setup_failed")
          console.error("[Raya] Local speech readiness refresh failed.", err)
          post({
            type: "speechRealtimeError",
            requestId: input.requestId,
            code: "setup_failed",
            error: "Local speech readiness was lost. Stop voice and reconnect.",
          })
        })
      }, this.interval)
      state.timer.unref()
    }
    schedule()
  }

  private async prepare(
    input: Parameters<SpeechService["realtimeStart"]>[0],
    settings: SpeechSettings,
    current: () => boolean,
  ) {
    const selected = () => current() && input.current?.() === true
    if (!selected()) throw new Error("The voice workspace changed before preparation.")
    await input.connection.getClientAsync(input.directory)
    const key = await this.settings.key("local")
    if (!selected() || !key) throw new Error("Local voice preparation is unavailable.")
    await this.localtts.prepare({
      id: input.requestId,
      endpoint: settings.localTtsEndpoint ?? "http://127.0.0.1:8770",
      key,
      model: settings.localTtsModel ?? "chatterbox-nano",
      voice: settings.localTtsVoice ?? "freeman-reference-c-AI",
    })
    if (!selected()) throw new Error("The voice workspace changed during preparation.")
  }

  async realtimeStop(request: string | undefined, post: Post): Promise<void> {
    if (request && request === this.waiting) {
      this.waiting = undefined
      post({ type: "speechRealtimeStopped", requestId: request })
      return
    }
    if (!request || request !== this.request) return
    if (this.closing) {
      await this.closing
      return
    }
    this.retiring = request
    const warm = this.warm
    this.cancel()
    const closing = (async () => {
      const results = await Promise.allSettled([this.realtime.stop(), this.localtts.cancel(), warm?.done])
      const result = results[0]
      const failure = result.status === "fulfilled" ? result.value : undefined
      const errors: unknown[] = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (this.warm === warm) this.warm = undefined
      if (errors.length) {
        if (failure) errors.push(new Error(failure.error))
        throw new AggregateError(errors, "Voice Stop could not confirm every original resource release.")
      }
      return failure
    })().then(
      (failure) => {
        if (!failure && this.request === request) this.request = undefined
        if (failure) {
          this.degrade(failure.code)
          post({ type: "speechRealtimeError", requestId: request, error: failure.error, code: failure.code })
          return false
        }
        post({ type: "speechRealtimeStopped", requestId: request })
        return true
      },
      (err) => {
        this.incomplete()
        console.error("[Raya] Local voice Stop could not confirm cleanup.", err)
        post({
          type: "speechRealtimeError",
          requestId: request,
          code: "cleanup_failed",
          error: "Local voice cleanup is unconfirmed. Restart Raya before reconnecting.",
        })
        return false
      },
    )
    this.closing = closing
    try {
      await closing
    } finally {
      if (this.closing === closing) this.closing = undefined
    }
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
    const failed = (error: string) => {
      this.failed()
      post({ type: "speechOpenAIError", requestId: input.requestId, error })
    }
    if (!(await this.admit(failed))) return
    if (this.realtime.active || this.live.active || this.openai.active) {
      post({
        type: "speechOpenAIError",
        requestId: input.requestId,
        error: "End the existing voice call before switching to OpenAI.",
      })
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
          warm: (handoff) => post({ type: "speechOpenAIHandoffPrepare", handoff }),
          usage: (usage) => {
            if (usage.incomplete) this.incomplete()
            if (!usage.incomplete && usage.pending === 0 && usage.unrecorded === 0) this.healthy()
            post({ type: "speechOpenAIUsage", requestId: input.requestId, sessionID: input.sessionID, usage })
          },
        }
      },
      (sdp) => {
        this.healthy()
        post({ type: "speechOpenAIReady", requestId: input.requestId, sdp })
      },
      failed,
    )
  }

  private async liveStart(input: Parameters<SpeechService["openaiStart"]>[0], post: Post): Promise<void> {
    const failed = (error: string) => {
      this.failed()
      post({ type: "speechOpenAIError", requestId: input.requestId, error })
    }
    if (!(await this.admit(failed))) return
    if (this.realtime.active || this.openai.active || this.live.active) {
      post({
        type: "speechOpenAIError",
        requestId: input.requestId,
        error: "End the existing voice call before switching to GPT-Live.",
      })
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
    if (this.closed) {
      failed("Voice is closed.")
      return
    }
    if (this.realtime.active || this.openai.active || this.live.active) {
      post({
        type: "speechOpenAIError",
        requestId: input.requestId,
        error: "End the existing voice call before switching to GPT-Live.",
      })
      return
    }
    await this.live.start(
      { requestID: input.requestId, sessionID: input.sessionID, sdp: input.sdp },
      async (signal) => {
        const settings = await this.settings.load()
        if (settings.voiceEngine !== "openai-live")
          throw new Error("GPT-Live voice is not selected in Speech settings.")
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
          key,
          voice: settings.openaiVoice,
          backend: server.baseUrl,
          authorization: `Basic ${Buffer.from(`kilo:${server.password}`).toString("base64")}`,
          directory: input.directory,
          current,
          context: context.text,
          started: () => post({ type: "speechLiveStarted", requestId: input.requestId }),
          usage: (usage) => {
            if (usage.incomplete) this.incomplete()
            if (usage.final && usage.recorded) this.healthy()
            post({ type: "speechLiveUsage", requestId: input.requestId, sessionID: input.sessionID, usage })
          },
        }
      },
      (answer) => {
        this.healthy()
        post({ type: "speechOpenAIReady", requestId: input.requestId, sdp: answer.sdp })
      },
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
      let dead = false
      await startLiveCapture(
        requestId,
        (buf) => {
          post({ type: "speechLiveMicChunk", requestId, data: buf.toString("base64") })
        },
        (error) => {
          dead = true
          failed(error)
        },
      )
      if (!dead) post({ type: "speechLiveMicReady", requestId })
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
    const openai = this.openai.stop(requestId)
    const live = this.live.stop(requestId)
    await stopLiveCapture(requestId)
    const errors = await Promise.all([openai, live])
    const error = errors.find((value) => value !== undefined)
    if (error) this.incomplete()
    post(error ? { type: "speechOpenAIError", requestId, error } : { type: "speechOpenAIStopped", requestId })
  }

  async openaiReset() {
    // Invoke both stops before awaiting: obsolete webview ownership is fenced immediately.
    const openai = this.openai.stop()
    const live = this.live.stop()
    const errors = await Promise.all([openai, live])
    if (errors.some(Boolean)) {
      this.incomplete()
      console.error("[Raya] Voice reset cleanup remains unconfirmed.")
    }
  }

  async openaiPrepare(handoff: Handoff, sdp: string, post: Post) {
    if (this.closed || !valid(handoff) || this.live.active || this.realtime.active)
      throw new Error("Voice replacement belongs to an unavailable call")
    await this.openai.prepare(
      handoff,
      sdp,
      (answer) => post({ type: "speechOpenAIHandoffAnswer", handoff, sdp: answer }),
      (error) => {
        post({ type: "speechOpenAIHandoffNotice", handoff, reason: "unavailable" })
        post({ type: "speechOpenAIError", requestId: handoff.target, error })
      },
    )
  }

  openaiPrepared(handoff: Handoff) {
    return this.openai.prepared(handoff)
  }

  async openaiQuiesce(value: HandoffQuiet) {
    if (!quiet(value)) throw new Error("Voice replacement quiet acknowledgement changed")
    this.openai.quiesce(
      { version: value.version, id: value.id, sessionID: value.sessionID, source: value.source, target: value.target },
      value.epoch,
    )
  }

  openaiCommit(handoff: Handoff) {
    return this.openai.commit(handoff)
  }

  openaiCutover(handoff: Handoff) {
    return this.openai.cutover(handoff)
  }

  async openaiRetire(handoff: Handoff, confirmed: boolean) {
    if (!confirmed) throw new Error("Voice source media retirement was not confirmed")
    const result = await this.openai.retire(handoff)
    if (!result.confirmed) {
      this.incomplete()
      throw new Error(result.error ?? "Voice source retirement remains unconfirmed")
    }
  }

  openaiCancel(handoff: Handoff) {
    return this.openai.cancel(handoff)
  }

  openaiState(handoff: Handoff) {
    return this.openai.state(handoff)
  }
  // raya_change end

  async transcribe(
    input: { requestId: string; data: string; format: string; model?: string; language?: string },
    post: Post,
  ): Promise<void> {
    const settings = await this.settings.load()
    const local = settings.sttEngine === "local"
    if (local && settings.sttEndpoint !== "http://127.0.0.1:8770/v1/audio/transcriptions") {
      post({
        type: "speechToTextError",
        requestId: input.requestId,
        error: "Local transcription requires the configured loopback service.",
      })
      return
    }
    const key = (await this.settings.key(local ? "local" : "stt")) ?? ""
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
        local,
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
    if (settings.sttEngine === "local")
      return (
        settings.sttEndpoint === "http://127.0.0.1:8770/v1/audio/transcriptions" && !!(await this.settings.key("local"))
      )
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

  async speak(input: { requestId: string; text: string; current?: () => boolean }, post: Post): Promise<void> {
    const trace = diagnostics(input.requestId, this.diagnostic)
    const current = () => input.current?.() ?? true
    if (!current()) return
    const send: Post = (message) => {
      const type = message && typeof message === "object" && "type" in message ? message.type : undefined
      const kind =
        type === "speechPlaybackChunk"
          ? "chunk"
          : type === "speechPlaybackVoice"
            ? "voice"
            : type === "speechPlaybackDone"
              ? "done"
              : type === "speechPlaybackError"
                ? "error"
                : undefined
      const forwarded = !this.closed && current()
      trace("callback", { kind, forwarded })
      if (forwarded) post(message)
    }
    if (this.closed) {
      post({ type: "speechPlaybackError", requestId: input.requestId, error: "Voice is closed." })
      return
    }
    const settings = await this.settings.load()
    if (!current()) return
    const local = settings.ttsEngine === "local-jobs"
    trace("start")
    const key = await this.settings.key(local ? "local" : "tts")
    if (!current()) return
    if (!key) {
      send({
        type: "speechPlaybackError",
        requestId: input.requestId,
        error: local ? "Configure local speech in Speech settings." : "Add the MiniMax TTS key in Speech settings.",
      })
      return
    }
    const stream = { started: false } // raya_change - send echo reference once without duplicating text on every chunk
    if (local) {
      await this.localtts.speak(
        {
          id: input.requestId,
          endpoint: settings.localTtsEndpoint ?? "http://127.0.0.1:8770",
          key,
          model: settings.localTtsModel ?? "chatterbox-nano",
          voice: settings.localTtsVoice ?? "freeman-reference-c-AI",
          text: input.text,
          allowFallback: settings.localTtsFallback,
        },
        {
          cleanup: (confirmed) => {
            if (!confirmed) this.incomplete()
          },
          voice: (choice) =>
            send({
              type: "speechPlaybackVoice",
              requestId: input.requestId,
              model: choice.model,
              voice: choice.voice,
              fallback: !!choice.fallback,
              reason: choice.fallback?.reason,
            }),
          chunk: (data, mime) => {
            if (this.closed) return
            send({
              type: "speechPlaybackChunk",
              requestId: input.requestId,
              data,
              mime,
              text: stream.started ? undefined : input.text,
            })
            stream.started = true
          },
          done: (result) => send({ type: "speechPlaybackDone", requestId: input.requestId, ...result }),
          error: (error) => send({ type: "speechPlaybackError", requestId: input.requestId, error }),
        },
      )
      return
    }
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
          send({
            type: "speechPlaybackChunk",
            requestId: input.requestId,
            data,
            mime,
            text: stream.started ? undefined : input.text,
          })
          stream.started = true
        },
        done: (result) => send({ type: "speechPlaybackDone", requestId: input.requestId, ...result }),
        error: (error) => send({ type: "speechPlaybackError", requestId: input.requestId, error }),
      },
    )
  }

  // raya_change start - authoritative backend-event handoff from Voice response to MiniMax
  markVoiceTurn(input: {
    requestId: string
    sessionID?: string
    draftID?: string
    directory?: string
    current?: () => boolean
  }): void {
    const prior = this.replies.request()
    if (!this.replies.mark(input)) return
    if (prior) this.cancel(prior)
  }

  captureVoiceSubmission() {
    return this.replies.snapshot()
  }

  captureVoiceTurn(sessionID: string) {
    return this.replies.capture(sessionID)
  }

  bindVoiceTurn(sessionID: string, messageID: string, requestId: string, draftID?: string, current?: () => boolean) {
    return this.replies.bind(sessionID, messageID, requestId, draftID, current)
  }

  trackMessage(
    sessionID: string,
    role: string,
    messageID: string,
    parentID?: string,
    ended = false,
    failed = false,
  ): void {
    this.replies.message(sessionID, role, messageID, parentID, ended, failed)
  }

  trackPart(
    sessionID: string,
    part: {
      id: string
      messageID?: string
      type: string
      text?: string
      synthetic?: boolean
      time?: { start?: number; end?: number; created?: number }
    },
  ): void {
    this.replies.part(sessionID, part)
  }

  removePart(sessionID: string, partID: string): void {
    this.replies.remove(sessionID, partID)
  }

  busy(sessionID: string, status?: string): void {
    if (status === "idle") return
    this.replies.busy(sessionID)
  }

  async speakOnIdle(sessionID: string, post: Post): Promise<void> {
    const reply = await this.replies.wait(sessionID)
    if (!reply || !reply.current()) return
    const trace = diagnostics(reply.requestId, this.diagnostic)
    trace("idle")
    if (reply.failed) {
      trace("error", { forwarded: !this.closed && reply.current() })
      if (!this.closed && reply.current())
        post({
          type: "speechPlaybackError",
          requestId: reply.requestId,
          error: "The Voice reply did not complete. Check the chat error and retry.",
        })
      return
    }
    try {
      const settings = await this.settings.load()
      if (!reply.current() || this.closed) return
      if (settings.mode === "off") {
        trace("handoff", { boundary: "skip", reason: "off" })
        return
      }
      if (["openai-realtime", "openai-live"].includes(settings.voiceEngine)) {
        trace("handoff", { boundary: "skip", reason: "cloud-engine" })
        return
      }
      if (this.openai.active || this.live.active) {
        trace("handoff", { boundary: "skip", reason: "live-active" })
        return
      }
      await this.speak({ requestId: reply.requestId, text: speakable(reply.text), current: reply.current }, post)
    } catch {
      trace("error", { forwarded: reply.current() && !this.closed })
      if (reply.current() && !this.closed)
        post({
          type: "speechPlaybackError",
          requestId: reply.requestId,
          error: "Voice playback could not start. Check Speech settings and retry.",
        })
    }
  }
  // raya_change end

  cancel(requestId?: string): void {
    if (this.warm && (!requestId || requestId === this.warm.request)) {
      clearTimeout(this.warm.timer)
      this.warm.alive = false
    }
    this.replies.cancel(requestId)
    if (requestId) this.aborts.get(requestId)?.abort()
    if (requestId) void cancelSpeechCapture(requestId) // raya_change - extension-host microphone fallback
    if (requestId) void stopLiveCapture(requestId)
    if (!requestId) {
      for (const ctrl of this.aborts.values()) ctrl.abort()
      this.aborts.clear()
    }
    this.tts.cancel(requestId)
    void this.localtts.cancel(requestId).catch((err) => {
      this.incomplete()
      console.error("[Raya] Local speech cancellation could not confirm service cleanup.", err)
    })
  }

  dispose(): void {
    this.closed = true
    this.cancel()
    const warm = this.warm
    void cancelLiveCapture()
    void this.enqueue(async () => {
      const live = await this.live.dispose()
      if (live) console.error("[Raya] Live voice disposal failed; resource release is unconfirmed.")
      const openai = await this.openai.dispose()
      if (openai) console.error("[Raya] OpenAI voice disposal failed:", openai)
      const realtime = await this.realtime.dispose()
      if (realtime) console.error("[Raya] Voice disposal failed:", realtime.error)
      this.tts.dispose()
      try {
        await this.localtts.dispose()
      } finally {
        await warm?.done
        if (this.warm === warm) this.warm = undefined
      }
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

function loadHealth(value: unknown): Health {
  if (value === undefined) return "ready"
  if (!value || typeof value !== "object" || Array.isArray(value)) return "incomplete"
  const saved = value as Record<string, unknown>
  if (saved.format !== "raya.voice-health" || saved.version !== 1) return "incomplete"
  if (saved.status === "ready" || saved.status === "failed" || saved.status === "incomplete") return saved.status
  return "incomplete"
}
