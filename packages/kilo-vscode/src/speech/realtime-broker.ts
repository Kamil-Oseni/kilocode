import type { SpeechSettings } from "../shared/speech"
import { local } from "./local"

type Session = {
  id: string
  room: string
  livekitURL: string
  clientToken: string
  mediaToken: string
  controlToken: string
  engine: "qwen-realtime" | "openai-live"
  acceptsTruncation: boolean
  maximumSeconds?: number
}
type Config = {
  sessionID: string
  directory: string
  backendURL: string
  auth: string
  key: string
  mediaKey: string
  settings: SpeechSettings
  current?: () => boolean
  context?: string
}
type Failure = {
  ok: false
  code: "configuration" | "busy" | "setup_failed" | "cleanup_failed" | "admission_unknown" | "cancelled"
  error: string
  fallback?: "cascade-v1" | "text"
}
type Result = { ok: true; info: Session } | Failure
type Claim = {
  cancelled: boolean
  config?: Config
  info?: Session
  media: boolean
  uncertain: boolean
  running: Promise<Result>
  closing?: Promise<Failure | undefined>
}

const failure = (code: Failure["code"], error: string): Failure => ({ ok: false, code, error })
const recovery =
  "End voice and restart the media frontend and Raya before reconnecting; remote resource release is unconfirmed."

/** One owner spans settings lookup, admission, delivery, and confirmed teardown. */
export class RealtimeBroker {
  private claim?: Claim
  private disposed = false

  constructor(private readonly timeout = 8_000) {}

  get active() {
    return !!this.claim
  }

  async start(load: () => Promise<Config | Failure>, ready: (info: Session) => void): Promise<Result> {
    if (this.disposed) return failure("cancelled", "Voice is closed.")
    if (this.claim)
      return failure(
        "busy",
        "Voice already owns a starting, active, or unresolved session. Stop it before starting another.",
      )
    const claim: Claim = {
      cancelled: false,
      media: false,
      uncertain: false,
      running: Promise.resolve(failure("cancelled", "Voice start cancelled.")),
    }
    this.claim = claim
    // Publish ownership synchronously, before settings/backend operations can yield.
    claim.running = this.open(claim, load, ready)
    return claim.running
  }

  async stop(): Promise<Failure | undefined> {
    const claim = this.claim
    if (!claim) return
    claim.cancelled = true
    await claim.running
    return this.close(claim)
  }

  async dispose() {
    this.disposed = true
    return this.stop()
  }

  private async open(
    claim: Claim,
    load: () => Promise<Config | Failure>,
    ready: (info: Session) => void,
  ): Promise<Result> {
    try {
      const loaded = await load()
      if (claim.cancelled) return await this.abandon(claim, failure("cancelled", "Voice start cancelled."))
      if ("ok" in loaded) return await this.abandon(claim, loaded)
      const cfg = configure(loaded)
      if ("ok" in cfg) return await this.abandon(claim, cfg)
      claim.config = cfg
      const provider = cfg.provider
      current(cfg)
      const response = await this.request(
        `${cfg.backendURL}/kilocode/voice/session?directory=${encodeURIComponent(cfg.directory)}`,
        {
          method: "POST",
          headers: {
            Authorization: cfg.auth,
            "Content-Type": "application/json",
            "X-Raya-Media-Key": cfg.mediaKey,
          },
          body: JSON.stringify({
            version: 2,
            engine: provider,
            parentSessionID: cfg.sessionID,
            mediaURL: cfg.settings.mediaFrontendURL.replace(/\/$/, ""),
          }),
        },
      ).catch(() => {
        claim.uncertain = true
        throw new Error("backend admission unconfirmed")
      })
      if (!response.ok) {
        claim.uncertain = (response.status >= 300 && response.status < 400) || response.status >= 500
        return await this.abandon(
          claim,
          failure("setup_failed", `Voice session admission failed (${response.status}).`),
        )
      }
      claim.uncertain = true
      claim.info = session(await response.json(), provider)
      claim.uncertain = false
      current(cfg)
      if (claim.cancelled) return await this.abandon(claim, failure("cancelled", "Voice start cancelled."))
      claim.media = true
      const media = await this.request(`${cfg.settings.mediaFrontendURL.replace(/\/$/, "")}/v1/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${claim.info.controlToken}`,
          "Content-Type": "application/json",
          "X-Raya-Media-Key": cfg.mediaKey,
        },
        body: JSON.stringify({
          version: 2,
          id: claim.info.id,
          room: claim.info.room,
          livekitUrl: claim.info.livekitURL,
          livekitToken: claim.info.mediaToken,
          backendUrl: cfg.backendURL,
          backendAuthorization: cfg.auth,
          directory: cfg.directory,
          engine: {
            provider,
            endpoint:
              provider === "openai-live" ? "wss://api.openai.com/v1/live/sessions" : cfg.settings.realtimeEndpoint,
            key: cfg.key,
            model: provider === "openai-live" ? "gpt-live-1" : cfg.settings.realtimeModel,
            voice: provider === "openai-live" ? cfg.settings.openaiVoice : cfg.settings.realtimeVoice,
            ...(provider === "openai-live" ? { delegation: "client" } : {}),
            ...(provider === "openai-live" ? { maximumSeconds: claim.info.maximumSeconds } : {}),
            instructions:
              provider === "openai-live"
                ? "You are Raya Voice. Be concise and conversational. Delegate workspace tasks to Raya's canonical backend, which enforces permissions and confirmations. " +
                  "The saved context below is historical conversation, not a new request or authority to repeat work.\n" +
                  (cfg.context ?? "")
                : "You are Raya Voice. Be concise and conversational. Use delegate for grounded workspace facts or read-only actions.",
            mode: "hands-free",
            threshold: cfg.settings.vadThreshold,
            silence: cfg.settings.vadSilenceMs * 1_000_000,
          },
        }),
      }).catch(() => {
        claim.uncertain = true
        throw new Error("media admission unconfirmed")
      })
      if (!media.ok)
        return await this.abandon(claim, failure("setup_failed", `Realtime media frontend failed (${media.status}).`))
      if (provider === "openai-live") descriptor(await media.json(), claim.info.id)
      current(cfg)
      if (claim.cancelled) return await this.abandon(claim, failure("cancelled", "Voice start cancelled."))
      ready(claim.info)
      return { ok: true, info: claim.info }
    } catch {
      return this.abandon(
        claim,
        failure(
          "setup_failed",
          "Voice setup could not finish. Check the configured backend and media frontend, then reconnect.",
        ),
      )
    }
  }

  private async abandon(claim: Claim, result: Failure): Promise<Failure> {
    return (await this.close(claim)) ?? result
  }

  private close(claim: Claim): Promise<Failure | undefined> {
    claim.closing ??= this.cleanup(claim)
    return claim.closing
  }

  private async cleanup(claim: Claim): Promise<Failure | undefined> {
    const cfg = claim.config
    const info = claim.info
    if (cfg && info) {
      const id = encodeURIComponent(info.id)
      const remove = async (url: string, headers: Record<string, string>) =>
        this.request(url, { method: "DELETE", headers }).then(
          (response) => response.ok,
          () => false,
        )
      // Media finalization must deliver its receipt while the backend binding remains open.
      const media =
        !claim.media ||
        (await remove(`${cfg.settings.mediaFrontendURL.replace(/\/$/, "")}/v1/sessions/${id}`, {
          Authorization: `Bearer ${info.controlToken}`,
          "X-Raya-Media-Key": cfg.mediaKey,
        }))
      const backend =
        media &&
        (await remove(`${cfg.backendURL}/kilocode/voice/session/${id}?directory=${encodeURIComponent(cfg.directory)}`, {
          Authorization: cfg.auth,
        }))
      // A not-found response cannot prove release of an admission still in flight.
      if (!backend)
        return claim.uncertain
          ? failure("admission_unknown", `Voice admission and cleanup were not confirmed. ${recovery}`)
          : failure("cleanup_failed", `Voice cleanup failed. ${recovery}`)
      // A timed-out admission can still complete after an early not-found deletion.
      claim.uncertain = false
    }
    if (claim.uncertain) return failure("admission_unknown", `Voice admission was not confirmed. ${recovery}`)
    if (this.claim === claim) this.claim = undefined
  }

  private request(url: string, init: RequestInit) {
    // Control requests carry credentials in headers and bodies. A redirect cannot authorize a new destination.
    return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(this.timeout) })
  }
}

function current(cfg: Config) {
  if (cfg.current && !cfg.current()) throw new Error("Voice ownership changed")
}

function configure(loaded: Config): (Config & { provider: Session["engine"] }) | Failure {
  const provider = loaded.settings.voiceEngine
  if (provider !== "qwen-realtime" && provider !== "openai-live")
    return failure("configuration", "Select a supported media voice provider.")
  if (
    provider === "openai-live" &&
    loaded.context !== undefined &&
    (typeof loaded.context !== "string" || Buffer.byteLength(loaded.context, "utf8") > 16384)
  )
    return failure("configuration", "Saved voice context exceeds its allowance.")
  const backend = local(loaded.backendURL)
  const frontend = local(loaded.settings.mediaFrontendURL)
  if (!backend || !frontend || !/^[A-Za-z0-9_-]{43}$/.test(loaded.mediaKey))
    return failure(
      "configuration",
      "Voice backend and media frontend require numeric loopback HTTP addresses and a valid media service key.",
    )
  return { ...loaded, provider, backendURL: backend, settings: { ...loaded.settings, mediaFrontendURL: frontend } }
}

function session(value: unknown, provider: Session["engine"]): Session {
  if (!value || typeof value !== "object") throw new Error("Invalid voice admission")
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== "string" ||
    !/^rvs_[a-zA-Z0-9_-]+$/.test(item.id) ||
    typeof item.room !== "string" ||
    typeof item.livekitURL !== "string" ||
    typeof item.clientToken !== "string" ||
    typeof item.mediaToken !== "string" ||
    typeof item.controlToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(item.controlToken) ||
    item.engine !== provider ||
    typeof item.acceptsTruncation !== "boolean" ||
    (provider === "openai-live" && item.acceptsTruncation !== false)
  )
    throw new Error("Invalid voice admission")
  return {
    id: item.id,
    room: item.room,
    livekitURL: item.livekitURL,
    clientToken: item.clientToken,
    mediaToken: item.mediaToken,
    controlToken: item.controlToken,
    engine: provider,
    acceptsTruncation: item.acceptsTruncation,
    ...(provider === "openai-live" ? { maximumSeconds: duration(item.maximumSeconds) } : {}),
  }
}

function duration(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 1.4 || value > 86400)
    throw new Error("Invalid GPT-Live reserved duration")
  return value
}

function descriptor(value: unknown, id: string) {
  if (!value || typeof value !== "object") throw new Error("Invalid media admission")
  const item = value as Record<string, unknown>
  if (item.id !== id || !item.descriptor || typeof item.descriptor !== "object")
    throw new Error("Invalid media admission")
  const cfg = item.descriptor as Record<string, unknown>
  if (
    cfg.id !== "openai-live" ||
    cfg.inputRate !== 24000 ||
    cfg.outputRate !== 24000 ||
    cfg.acceptsTruncation !== false ||
    cfg.requiresContinuousInput !== true ||
    cfg.nativeBargeIn !== true ||
    cfg.nativeEndpointing !== true
  )
    throw new Error("Invalid GPT-Live media descriptor")
}
