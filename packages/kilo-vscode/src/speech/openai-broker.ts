import { OpenAISpeech } from "./openai-speech"
import { OpenAIUsage } from "./openai-usage"
import type { VoiceUsage } from "../shared/voice-usage"
import { OpenAIImages } from "./openai-images"
import { cancelled } from "../shared/voice-interruption"
import { createHash, randomBytes } from "node:crypto"
import WebSocket from "ws"
import { OPENAI_VOICE_MODEL } from "../shared/speech"
import { sameDirectory } from "../kilo-provider-utils"

type Config = {
  key: string
  voice: string
  backend: string
  authorization: string
  directory: string
  current: () => boolean
  usage?: (state: VoiceUsage) => void
}

type Binding = {
  id: string
  generation: string
  parentSessionID: string
  providerCallID: string
  status: string
  directory: string
  model: string
}

type Input = { requestID: string; sessionID: string; sdp: string }
type Work = { id: string; name: unknown; arguments: string; responseID?: string; itemID?: string }
type Claim = {
  input: Input
  capability: string
  abort: AbortController
  calls: Map<string, string>
  queue: Promise<void>
  blocked: boolean
  cancelled: boolean
  uncertain: boolean
  speech: OpenAISpeech
  usage?: OpenAIUsage
  images: OpenAIImages
  cancellations: Set<string>
  config?: Config
  remote?: string
  binding?: Binding
  socket?: WebSocket
  timer?: ReturnType<typeof setInterval>
  closing?: Promise<string | undefined>
  opening: Promise<void>
  failed: (error: string) => void
}

const origin = "https://api.openai.com"
const endpoint = `${origin}/v1/realtime/calls`
const model = OPENAI_VOICE_MODEL
const limit = 262_144
const instructions =
  "You are Raya, speaking with the user in their existing work conversation. Be concise and natural. " +
  "Use raya_work for workspace facts, investigation, changes, or other work. Never claim work succeeded without its result. " +
  "The normal Raya conversation owns permissions, goals, tools and evidence. Do not invent access or a completed result. " +
  "Spoken interruption stops your speech; it does not by itself cancel work."
const tool = {
  type: "function",
  name: "raya_work",
  description:
    "Run the user's requested work in their existing Raya conversation with its current permissions and goals.",
  parameters: {
    type: "object",
    properties: {
      request: { type: "string", maxLength: 8000 },
      images: {
        type: "array",
        items: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" },
        maxItems: 4,
        uniqueItems: true,
      },
    },
    required: ["request"],
    additionalProperties: false,
  },
}

/** Provider credentials and work dispatch never enter the webview. */
export class OpenAIBroker {
  private claim?: Claim
  private disposed = false

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly connect = (url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options),
  ) {}

  get active() {
    return !!this.claim
  }

  async start(
    input: Input,
    load: () => Promise<Config>,
    ready: (sdp: string) => void,
    failed: (error: string) => void,
  ) {
    if (this.disposed || this.claim) {
      failed("Voice already owns a starting, active, or unresolved call. End it before reconnecting.")
      return
    }
    if (!identifier(input.requestID) || !identifier(input.sessionID) || !sdp(input.sdp)) {
      failed("The voice connection request is invalid. End voice and try again.")
      return
    }
    const claim: Claim = {
      input,
      capability: randomBytes(32).toString("hex"),
      abort: new AbortController(),
      calls: new Map(),
      images: new OpenAIImages(),
      cancellations: new Set(),
      queue: Promise.resolve(),
      blocked: false,
      cancelled: false,
      uncertain: false,
      speech: new OpenAISpeech(
        (event) => this.send(claim, event),
        () => this.current(claim) && !claim.blocked,
        failed,
      ),
      opening: Promise.resolve(),
      failed,
    }
    this.claim = claim
    claim.opening = this.open(claim, load, ready).catch(async (error: unknown) => {
      const cancelled = claim.cancelled
      const cleanup = await this.close(claim)
      if (!cancelled || cleanup) failed(cleanup ?? message(error))
    })
    await claim.opening
  }

  interrupt(requestID: string, responseID: string, eventID: string) {
    const claim = this.claim
    if (!claim || claim.input.requestID !== requestID || !this.current(claim)) return
    if (!identifier(responseID) || !identifier(eventID) || claim.speech.output !== responseID) return
    if (claim.cancellations.has(eventID)) return
    claim.cancellations.add(eventID)
    if (claim.cancellations.size > 32) claim.cancellations.delete(claim.cancellations.values().next().value!)
    if (claim.speech.generating(responseID))
      this.send(claim, { type: "response.cancel", response_id: responseID, event_id: eventID })
    this.send(claim, { type: "output_audio_buffer.clear", event_id: `${eventID}_clear` })
  }

  async share(requestID: string, imageID: string, data: string) {
    const claim = this.claim
    if (!claim || claim.input.requestID !== requestID || !this.current(claim) || !claim.binding)
      return { status: "failed" as const, error: "Start voice in this conversation before sharing an image." }
    return claim.images.share(
      imageID,
      data,
      claim.abort.signal,
      async (image) => {
        const separator = image.data.indexOf(",")
        const receipt = await this.backend(claim, `/session/${encodeURIComponent(claim.binding!.id)}/images`, {
          method: "POST",
          body: JSON.stringify({
            generation: claim.binding!.generation,
            id: image.id,
            mime: image.data.slice(5, image.data.indexOf(";")),
            data: image.data.slice(separator + 1),
          }),
        })
        this.assert(claim)
        return receipt
      },
      (event) => {
        this.assert(claim)
        if (claim.socket?.readyState !== WebSocket.OPEN) throw new Error("Voice image transport closed")
        this.send(claim, event)
      },
    )
  }

  async stop(requestID?: string) {
    const claim = this.claim
    if (!claim || (requestID && claim.input.requestID !== requestID)) return
    claim.cancelled = true
    claim.abort.abort()
    await claim.opening
    return this.close(claim)
  }

  async dispose() {
    this.disposed = true
    return this.stop()
  }

  private current(claim: Claim) {
    return this.claim === claim && !claim.cancelled && !claim.abort.signal.aborted && !!claim.config?.current()
  }

  private assert(claim: Claim) {
    if (!this.current(claim))
      throw new Error("The voice connection or workspace changed. End voice before reconnecting.")
  }

  private async open(claim: Claim, load: () => Promise<Config>, ready: (sdp: string) => void) {
    claim.config = await load()
    this.assert(claim)
    const cfg = claim.config
    const form = new FormData()
    form.set("sdp", claim.input.sdp)
    form.set(
      "session",
      JSON.stringify({
        type: "realtime",
        model,
        instructions,
        tools: [],
        audio: { output: { voice: cfg.voice } },
      }),
    )
    claim.uncertain = true
    const response = await this.request(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: form,
      redirect: "error",
      signal: AbortSignal.any([claim.abort.signal, AbortSignal.timeout(30_000)]),
    })
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408) claim.uncertain = false
      await response.body?.cancel()
      throw new Error(`OpenAI voice setup failed (${response.status}). Check your OpenAI key and model access.`)
    }
    claim.remote = location(response.headers.get("Location"))
    claim.uncertain = false
    const answer = await bounded(response)
    if (!sdp(answer)) throw new Error("OpenAI returned an invalid voice connection answer.")
    this.assert(claim)
    // A missing acknowledgment may still have created the binding. Preserve ownership.
    claim.uncertain = true
    const binding = await this.backend(claim, "/session", {
      method: "POST",
      body: JSON.stringify({
        parentSessionID: claim.input.sessionID,
        providerCallID: claim.remote,
        requestID: claim.input.requestID,
      }),
    })
    claim.binding = admission(binding, claim)
    claim.usage = new OpenAIUsage(
      claim.abort.signal,
      (receipt) =>
        this.backend(claim, `/session/${encodeURIComponent(claim.binding!.id)}/usage`, {
          method: "POST",
          body: JSON.stringify({ generation: claim.binding!.generation, receipt }),
        }),
      (state) => claim.config?.usage?.(state),
    )
    claim.uncertain = false
    this.assert(claim)
    await this.sideband(claim)
    this.assert(claim)
    claim.timer = setInterval(() => this.validate(claim), 1000)
    claim.timer.unref()
    ready(answer)
  }

  private validate(claim: Claim) {
    if (this.current(claim)) return true
    if (this.claim !== claim || claim.cancelled) return false
    claim.failed("The voice workspace or backend changed. Voice is closing; review ongoing work before reconnecting.")
    void this.stop(claim.input.requestID).then((error) => error && claim.failed(error))
    return false
  }

  private sideband(claim: Claim) {
    const socket = this.connect(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(claim.remote!)}`, {
      headers: { Authorization: `Bearer ${claim.config!.key}` },
      handshakeTimeout: 15_000,
      maxPayload: 524_288,
      perMessageDeflate: false,
    })
    claim.socket = socket
    return new Promise<void>((resolve, reject) => {
      let ready = false
      const timer = setTimeout(() => reject(new Error("OpenAI voice control did not become ready.")), 20_000)
      const abort = () => reject(new Error("Voice setup was cancelled."))
      claim.abort.signal.addEventListener("abort", abort, { once: true })
      const finish = () => {
        clearTimeout(timer)
        claim.abort.signal.removeEventListener("abort", abort)
      }
      socket.on("open", () => {
        if (!this.current(claim)) return abort()
        this.send(claim, {
          type: "session.update",
          session: {
            type: "realtime",
            instructions,
            tools: [tool],
            tool_choice: "auto",
            audio: {
              input: {
                transcription: { model: "gpt-live-transcribe", delay: "low" },
                turn_detection: {
                  type: "semantic_vad",
                  eagerness: "auto",
                  interrupt_response: true,
                  create_response: true,
                },
              },
            },
          },
        })
      })
      socket.on("message", (data) => {
        if (!this.validate(claim)) return
        const event = object(data.toString(), 524_288)
        if (!event) return
        if (event.type === "session.updated" && configured(event.session)) {
          ready = true
          finish()
          resolve()
          return
        }
        if (event.type === "error" && !ready) {
          finish()
          reject(new Error("OpenAI rejected the voice session configuration."))
          return
        }
        if (ready) this.event(claim, event)
      })
      const failure = () => {
        finish()
        if (!ready) reject(new Error("OpenAI voice control disconnected during setup."))
        if (ready && this.claim === claim && !claim.cancelled) {
          claim.failed("OpenAI voice control disconnected. End voice and review ongoing work before reconnecting.")
          void this.close(claim).then((error) => error && claim.failed(error))
        }
      }
      socket.on("error", failure)
      socket.on("close", failure)
    })
  }

  private send(claim: Claim, value: unknown) {
    if (!this.current(claim) || claim.socket?.readyState !== WebSocket.OPEN) return
    claim.socket.send(JSON.stringify(value))
  }

  private event(claim: Claim, event: Record<string, unknown>) {
    claim.usage?.receive(event)
    if (claim.images.receive(event)) return
    if (event.type === "error" && cancelled(event, claim.cancellations)) return
    const handled = claim.speech.event(event)
    if (event.type === "response.done" && !handled) this.completed(claim, event.response)
    if (event.type === "error" && !handled)
      claim.failed(
        "OpenAI could not complete a voice response. Your work remains in the conversation; review it before retrying.",
      )
    claim.speech.flush()
  }

  private completed(claim: Claim, value: unknown) {
    if (!value || typeof value !== "object") return
    const response = value as Record<string, unknown>
    if (
      response.status !== "completed" ||
      !identifier(response.id) ||
      !Array.isArray(response.output) ||
      response.output.length > 64
    )
      return
    for (const value of response.output) {
      if (!value || typeof value !== "object") continue
      const item = value as Record<string, unknown>
      if (item.type !== "function_call" || item.status !== "completed") continue
      this.queue(claim, {
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
        response_id: response.id,
        item_id: item.id,
      })
    }
  }

  private queue(claim: Claim, event: Record<string, unknown>) {
    if (claim.blocked || !this.validate(claim)) return
    if (!identifier(event.call_id) || typeof event.arguments !== "string" || event.arguments.length > 16_000) return
    const id = event.call_id
    const digest = createHash("sha256").update(event.arguments).digest("hex")
    if (claim.calls.has(id)) {
      if (claim.calls.get(id) !== digest) this.block(claim)
      return
    }
    if (claim.calls.size >= 64) return this.block(claim)
    claim.calls.set(id, digest)
    const work: Work = {
      id,
      name: event.name,
      arguments: event.arguments,
      ...(identifier(event.response_id) ? { responseID: event.response_id } : {}),
      ...(identifier(event.item_id) ? { itemID: event.item_id } : {}),
    }
    // Reserve deduplication synchronously, so queued duplicates cannot grow this chain.
    // Wait for the prior retained result before admitting another backend call.
    claim.queue = claim.queue
      .then(async () => {
        if (!claim.blocked && this.validate(claim)) await this.work(claim, work)
      })
      .catch(() => this.block(claim))
  }

  private block(claim: Claim) {
    if (claim.blocked) return
    claim.blocked = true
    claim.speech.finish()
    if (this.current(claim)) claim.failed("Voice work could not be confirmed. Review the conversation before retrying.")
  }

  private async work(claim: Claim, event: Work) {
    const id = event.id
    const args = object(event.arguments)
    if (
      event.name !== "raya_work" ||
      !args ||
      typeof args.request !== "string" ||
      !args.request.trim() ||
      args.request.length > 8000 ||
      Object.keys(args).some((key) => key !== "request" && key !== "images") ||
      (args.images !== undefined &&
        (!Array.isArray(args.images) ||
          args.images.length > 4 ||
          !args.images.every(identifier) ||
          new Set(args.images).size !== args.images.length))
    ) {
      this.output(claim, id, { status: "failed", error: "Unsupported voice work request. No work was started." })
      return
    }
    const binding = claim.binding!
    const path = `/session/${encodeURIComponent(binding.id)}/calls`
    claim.speech.start(id)
    const initial = await this.backend(claim, path, {
      method: "POST",
      body: JSON.stringify({
        generation: binding.generation,
        callID: id,
        function: "raya_work",
        arguments: args,
        ...(event.responseID ? { responseID: event.responseID } : {}),
        ...(event.itemID ? { itemID: event.itemID } : {}),
      }),
    })
    const result = await this.result(claim, id, `${path}/${encodeURIComponent(id)}`, initial)
    claim.speech.finish()
    this.output(claim, id, result)
  }

  private async result(claim: Claim, id: string, path: string, initial: Record<string, unknown>) {
    receipt(initial, claim, id)
    claim.speech.observe(id, initial.status)
    let result = initial
    const deadline = Date.now() + 30 * 60_000
    while (result.status === "accepted" || result.status === "running") {
      this.assert(claim)
      if (Date.now() >= deadline)
        return {
          status: "unknown",
          error: "Work is still unresolved. Review the existing conversation; do not automatically repeat it.",
        }
      await delay(claim.abort.signal)
      result = await this.backend(claim, path, { method: "GET" })
      receipt(result, claim, id, initial)
      claim.speech.observe(id, result.status)
    }
    if (!["completed", "failed", "cancelled", "unknown"].includes(String(result.status)))
      throw new Error("Invalid voice work result")
    return result
  }

  private output(claim: Claim, id: string, result: unknown) {
    const item = `raya_result_${randomBytes(12).toString("hex")}`
    const output = JSON.stringify(result)
    claim.speech.result(item, id, output)
    this.send(claim, {
      type: "conversation.item.create",
      event_id: item,
      item: { id: item, type: "function_call_output", call_id: id, output },
    })
  }

  private async backend(claim: Claim, path: string, init: RequestInit, cleanup = false) {
    const cfg = claim.config!
    if (!cleanup) this.assert(claim)
    const url = new URL(`${cfg.backend.replace(/\/$/, "")}/kilocode/voice/openai${path}`)
    url.searchParams.set("directory", cfg.directory)
    if (claim.binding) url.searchParams.set("generation", claim.binding.generation)
    const response = await this.request(url, {
      ...init,
      redirect: "error",
      headers: {
        Authorization: cfg.authorization,
        "Content-Type": "application/json",
        "X-Raya-Voice-Key": claim.capability,
      },
      signal: cleanup
        ? AbortSignal.timeout(15_000)
        : AbortSignal.any([claim.abort.signal, AbortSignal.timeout(30_000)]),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `Raya voice work could not be confirmed (${response.status}). Review the conversation before retrying.`,
      )
    }
    const value = object(await bounded(response))
    if (!value) throw new Error("Invalid Raya voice response")
    return value
  }

  private close(claim: Claim) {
    claim.closing ??= this.cleanup(claim)
    return claim.closing
  }

  private async cleanup(claim: Claim): Promise<string | undefined> {
    claim.cancelled = true
    claim.speech.close()
    clearInterval(claim.timer)
    claim.abort.abort()
    claim.socket?.terminate()
    const results = await Promise.allSettled([
      ...(claim.remote && claim.config ? [this.hangup(claim)] : []),
      ...(claim.binding
        ? [
            this.backend(claim, `/session/${encodeURIComponent(claim.binding.id)}`, { method: "DELETE" }, true).then(
              (binding) => {
                if (
                  binding.id !== claim.binding!.id ||
                  binding.generation !== claim.binding!.generation ||
                  binding.status !== "closed"
                )
                  throw new Error("Raya voice work release remains unconfirmed")
              },
            ),
          ]
        : []),
    ])
    if (claim.uncertain || results.some((result) => result.status === "rejected"))
      return "Voice admission or cleanup remains unconfirmed. Restart Raya before reconnecting; review ongoing work in the conversation."
    if (this.claim === claim) this.claim = undefined
  }

  private async hangup(claim: Claim) {
    const response = await this.request(`${endpoint}/${encodeURIComponent(claim.remote!)}/hangup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${claim.config!.key}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error("OpenAI call release was not confirmed")
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

function sdp(value: string) {
  return value.length <= limit && /^v=0\r?\n/.test(value) && /^m=audio /m.test(value) && !/^m=video /m.test(value)
}

function location(value: string | null) {
  if (!value) throw new Error("OpenAI did not return a call identity")
  const url = new URL(value, origin)
  const match = /^\/v1\/realtime\/calls\/(rtc_[a-zA-Z0-9_-]+)$/.exec(url.pathname)
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    !identifier(match[1])
  )
    throw new Error("OpenAI returned an invalid call identity")
  return match[1]
}

function object(value: string, maximum = limit): Record<string, unknown> | undefined {
  if (value.length > maximum) return
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function configured(value: unknown) {
  if (!value || typeof value !== "object") return false
  const session = value as Record<string, unknown>
  if (!session.audio || typeof session.audio !== "object") return false
  const audio = session.audio as Record<string, unknown>
  if (!audio.input || typeof audio.input !== "object") return false
  const input = audio.input as Record<string, unknown>
  if (!input.turn_detection || typeof input.turn_detection !== "object") return false
  const turn = input.turn_detection as Record<string, unknown>
  return (
    turn.type === "semantic_vad" &&
    turn.create_response === true &&
    turn.interrupt_response === true &&
    Array.isArray(session.tools) &&
    session.tools.some((item) => item && typeof item === "object" && item.name === "raya_work")
  )
}

function admission(value: Record<string, unknown>, claim: Claim): Binding {
  if (
    !identifier(value.id) ||
    !identifier(value.generation) ||
    value.parentSessionID !== claim.input.sessionID ||
    value.providerCallID !== claim.remote ||
    value.status !== "active" ||
    value.model !== model ||
    typeof value.directory !== "string" ||
    !sameDirectory(value.directory, claim.config!.directory)
  )
    throw new Error("Raya voice binding was not confirmed")
  return value as Binding
}

function receipt(value: Record<string, unknown>, claim: Claim, id: string, initial?: Record<string, unknown>) {
  if (
    !identifier(value.id) ||
    !identifier(value.messageID) ||
    value.callID !== id ||
    value.parentSessionID !== claim.input.sessionID ||
    (initial && (value.id !== initial.id || value.messageID !== initial.messageID))
  )
    throw new Error("Voice work receipt belongs to another request")
  if (value.status !== "completed") return
  if (!value.result || typeof value.result !== "object") throw new Error("Voice work result is missing")
  const result = value.result as Record<string, unknown>
  if (
    typeof result.text !== "string" ||
    result.text.length > 12_000 ||
    !identifier(result.assistantMessageID) ||
    !Array.isArray(result.evidence) ||
    result.evidence.length > 64
  )
    throw new Error("Invalid voice work evidence")
}

function message(error: unknown) {
  return error instanceof Error && error.message.startsWith("OpenAI ")
    ? error.message
    : "Voice setup could not be confirmed. Check the connection and review ongoing work before retrying."
}

async function bounded(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Empty voice response")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) return Buffer.concat(chunks).toString("utf8")
      size += item.value.byteLength
      if (size > limit) throw new Error("Voice response limit exceeded")
      chunks.push(item.value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

function delay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new Error("Voice work polling cancelled"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, 1500)
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
  })
}
