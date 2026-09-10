import type { SpeechSettings } from "../shared/speech"

type Session = {
  id: string
  room: string
  livekitURL: string
  clientToken: string
  mediaToken: string
  engine: "qwen-realtime"
  acceptsTruncation: boolean
}
type Config = {
  sessionID: string
  directory: string
  backendURL: string
  auth: string
  key: string
  settings: SpeechSettings
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
      claim.config = loaded
      const cfg = claim.config
      const response = await this.request(
        `${cfg.backendURL}/kilocode/voice/session?directory=${encodeURIComponent(cfg.directory)}`,
        {
          method: "POST",
          headers: { Authorization: cfg.auth, "Content-Type": "application/json" },
          body: JSON.stringify({
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
      claim.info = session(await response.json())
      claim.uncertain = false
      if (claim.cancelled) return await this.abandon(claim, failure("cancelled", "Voice start cancelled."))
      claim.media = true
      const media = await this.request(`${cfg.settings.mediaFrontendURL.replace(/\/$/, "")}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: claim.info.id,
          room: claim.info.room,
          livekitUrl: claim.info.livekitURL,
          livekitToken: claim.info.mediaToken,
          backendUrl: cfg.backendURL,
          backendAuthorization: cfg.auth,
          directory: cfg.directory,
          engine: {
            endpoint: cfg.settings.realtimeEndpoint,
            key: cfg.key,
            model: cfg.settings.realtimeModel,
            voice: cfg.settings.realtimeVoice,
            instructions:
              "You are Raya Voice. Be concise and conversational. Use delegate for grounded workspace facts or read-only actions.",
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
      const results = await Promise.allSettled([
        ...(claim.media
          ? [
              this.request(`${cfg.settings.mediaFrontendURL.replace(/\/$/, "")}/v1/sessions/${id}`, {
                method: "DELETE",
              }),
            ]
          : []),
        this.request(`${cfg.backendURL}/kilocode/voice/session/${id}?directory=${encodeURIComponent(cfg.directory)}`, {
          method: "DELETE",
          headers: { Authorization: cfg.auth },
        }),
      ])
      // Older media frontends also report cleanup errors as 404. A status alone cannot prove release.
      if (results.some((result) => result.status === "rejected" || !result.value.ok))
        return claim.uncertain
          ? failure("admission_unknown", `Voice admission and cleanup were not confirmed. ${recovery}`)
          : failure("cleanup_failed", `Voice cleanup failed. ${recovery}`)
      // A timed-out admission can still complete after an early not-found deletion.
      if (claim.uncertain && results.every((result) => result.status === "fulfilled" && result.value.ok))
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

function session(value: unknown): Session {
  if (!value || typeof value !== "object") throw new Error("Invalid voice admission")
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== "string" ||
    !/^rvs_[a-zA-Z0-9_-]+$/.test(item.id) ||
    typeof item.room !== "string" ||
    typeof item.livekitURL !== "string" ||
    typeof item.clientToken !== "string" ||
    typeof item.mediaToken !== "string" ||
    item.engine !== "qwen-realtime" ||
    typeof item.acceptsTruncation !== "boolean"
  )
    throw new Error("Invalid voice admission")
  return {
    id: item.id,
    room: item.room,
    livekitURL: item.livekitURL,
    clientToken: item.clientToken,
    mediaToken: item.mediaToken,
    engine: item.engine,
    acceptsTruncation: item.acceptsTruncation,
  }
}
