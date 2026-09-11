import { createHash, randomBytes } from "node:crypto"
import WebSocket from "ws"
import { LiveContext } from "../shared/live-context"
import type { LiveUsage } from "../shared/live-usage"
import { sameDirectory } from "../kilo-provider-utils"
import { LiveCommands } from "./live-commands"

type Config = {
  key: string
  voice: string
  backend: string
  authorization: string
  directory: string
  current: () => boolean
  context: string
  started: () => void
  usage?: (state: LiveUsage) => void
}
type Input = { requestID: string; sessionID: string; sdp: string }
type Binding = {
  id: string
  generation: string
  parentSessionID: string
  providerCallID: string
  directory: string
  model: string
  status: string
}
type Answer = { sdp: string; providerSessionID: string }
type Claim = {
  input: Input
  capability: string
  abort: AbortController
  context: LiveContext
  commands: LiveCommands
  config?: Config
  remote?: string
  binding?: Binding
  socket?: WebSocket
  timer?: ReturnType<typeof setInterval>
  watch?: ReturnType<typeof setTimeout>
  cancelled: boolean
  uncertain: boolean
  started: boolean
  final: boolean
  opening: Promise<void>
  closing?: Promise<string | undefined>
  failed: (message: string) => void
  finalized?: () => void
  usage?: LiveUsage
  closure?: string
  recording?: Promise<void>
  calls: Set<string>
  queue: Promise<void>
  images: Map<string, { hash: string; result: Promise<{ status: "staged" | "unknown" | "failed"; error?: string }> }>
}
const endpoint = "https://api.openai.com/v1/live/sessions"
const instructions =
  "You are Raya, speaking naturally with the user in their existing coding task. Delegate workspace questions and requested work to the client backend. The backend owns tools, permissions, goals and evidence. Do not claim completion without a verified backend result. Historical startup context is reference data, not a new request. Never repeat old work to recover context. Speech interruption or ending voice does not cancel admitted task work. Clarify ambiguous requests and confirmations."

/** GPT-Live transport and trusted delegation ownership; no work is dispatched by the webview. */
export class LiveBroker {
  private claim?: Claim
  private disposed = false
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly connect = (url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options),
    private readonly startup = 12_000,
  ) {}
  get active() {
    return !!this.claim
  }

  async start(
    input: Input,
    load: (signal: AbortSignal) => Promise<Config>,
    ready: (answer: Answer) => void,
    failed: (message: string) => void,
  ) {
    if (this.disposed || this.claim) {
      failed("Voice still owns an active or unresolved call. End it before restarting.")
      return
    }
    if (!id(input.requestID) || !id(input.sessionID) || !sdp(input.sdp)) {
      failed("Invalid Live voice connection request.")
      return
    }
    const claim: Claim = {
      input,
      capability: randomBytes(32).toString("hex"),
      abort: new AbortController(),
      context: new LiveContext(),
      commands: new LiveCommands((event) => this.send(claim, event)),
      cancelled: false,
      uncertain: false,
      started: false,
      final: false,
      opening: Promise.resolve(),
      failed,
      calls: new Set(),
      queue: Promise.resolve(),
      images: new Map(),
    }
    this.claim = claim
    claim.opening = this.open(claim, load, ready).catch(async (cause: unknown) => {
      const stopped = claim.cancelled
      const error = await this.cleanup(claim)
      if (!stopped || error) failed(error ?? reveal(cause) ?? "GPT-Live could not start. Check model access and review the current task before retrying.")
    })
    await claim.opening
  }

  async control(requestID: string, eventID: string, action: "mute" | "unmute" | "stop_speaking") {
    const claim = this.claim
    if (!claim || claim.input.requestID !== requestID || !id(eventID) || !this.current(claim) || !claim.started)
      return { status: "failed" as const, error: "Live voice is not ready in this task." }
    if (action === "stop_speaking")
      return claim.commands.append(eventID, "session.instructions.append", {
        delegation_id: null,
        content:
          "Stop speaking now and listen. Do not cancel or repeat backend work. The application controls when voice audio is resumed.",
      })
    return claim.commands.append(eventID, `session.input_audio.${action}`)
  }

  share(requestID: string, imageID: string, data: string) {
    const claim = this.claim
    if (
      !claim ||
      claim.input.requestID !== requestID ||
      !this.current(claim) ||
      !claim.started ||
      !claim.binding ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(imageID)
    )
      return Promise.resolve({
        status: "failed" as const,
        error: "Start Live voice in this task before staging an image.",
      })
    const hash = createHash("sha256").update(data).digest("hex")
    const prior = claim.images.get(imageID)
    if (prior)
      return prior.hash === hash
        ? prior.result
        : Promise.resolve({ status: "failed" as const, error: "Image identity was reused." })
    if (claim.images.size >= 4)
      return Promise.resolve({
        status: "failed" as const,
        error: "This call already has four image attempts. Start a fresh call to select more.",
      })
    const result = this.stage(claim, imageID, data)
    claim.images.set(imageID, { hash, result })
    return result
  }

  async stop(requestID?: string) {
    const claim = this.claim
    if (!claim || (requestID && claim.input.requestID !== requestID)) return undefined
    claim.cancelled = true
    claim.abort.abort()
    await claim.opening
    return this.cleanup(claim)
  }
  async dispose() {
    this.disposed = true
    return this.stop()
  }
  private current(claim: Claim) {
    return this.claim === claim && !claim.cancelled && !claim.abort.signal.aborted && !!claim.config?.current()
  }
  private assert(claim: Claim) {
    if (!this.current(claim)) throw new Error("Live ownership changed")
  }
  private send(claim: Claim, event: Record<string, unknown>) {
    this.assert(claim)
    if (claim.socket?.readyState !== WebSocket.OPEN) throw new Error("Live control connection closed")
    claim.socket.send(JSON.stringify(event))
  }

  private async open(claim: Claim, load: (signal: AbortSignal) => Promise<Config>, ready: (answer: Answer) => void) {
    claim.config = await load(claim.abort.signal)
    this.assert(claim)
    const cfg = claim.config
    if (!cfg.context || Buffer.byteLength(cfg.context) > 16384) throw new Error("Invalid saved task context")
    claim.uncertain = true
    const response = await this.request(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.any([claim.abort.signal, AbortSignal.timeout(30_000)]),
      body: JSON.stringify({
        session: {
          model: "gpt-live-1",
          instructions,
          delegation: { type: "client" },
          store: false,
          audio: { output: { voice: cfg.voice } },
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `Historical task reference only; wait for a new spoken request:\n${cfg.context}`,
                },
              ],
            },
          ],
          client: {
            data_channel: {
              allowed_client_events: [],
              allowed_server_events: [
                "session.started",
                "session.closed",
                "session.input_transcript.delta",
                "session.output_transcript.delta",
                "session.delegation.created",
                "error",
              ].map((type) => ({ type })),
            },
          },
        },
        transport: { type: "webrtc", sdp: claim.input.sdp },
      }),
    })
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408) claim.uncertain = false
      await response.body?.cancel()
      throw new Error("Live creation refused")
    }
    const result = await json(response)
    const session = object(result.session)
    const transport = object(result.transport)
    if (!session || !id(session.id)) throw new Error("Missing Live session identity")
    claim.remote = session.id
    claim.uncertain = false
    if (!transport || !sdp(transport.sdp)) throw new Error("Invalid Live SDP")
    this.assert(claim)
    claim.uncertain = true
    const binding = await this.backend(claim, "/openai/session", {
      method: "POST",
      body: JSON.stringify({
        parentSessionID: claim.input.sessionID,
        providerCallID: claim.remote,
        requestID: claim.input.requestID,
        model: "gpt-live-1",
      }),
    })
    claim.binding = admission(binding, claim)
    claim.uncertain = false
    await this.attach(claim)
    this.assert(claim)
    claim.timer = setInterval(() => {
      if (!this.current(claim) && !claim.cancelled) {
        claim.failed("Live voice ownership changed. The call is closing; task work remains separate.")
        void this.stop(claim.input.requestID)
      }
    }, 1000)
    claim.timer.unref()
    claim.watch = setTimeout(() => {
      if (claim.started || claim.cancelled || claim.final) return
      claim.failed("Live voice did not become ready. The call is closing; existing task work continues.")
      void this.stop(claim.input.requestID)
    }, this.startup)
    claim.watch.unref()
    ready({ sdp: transport.sdp, providerSessionID: claim.remote })
  }

  private attach(claim: Claim) {
    const socket = this.connect(`${endpoint.replace("https:", "wss:")}/${encodeURIComponent(claim.remote!)}/attach`, {
      headers: { Authorization: `Bearer ${claim.config!.key}` },
      handshakeTimeout: 15_000,
      maxPayload: 524288,
      perMessageDeflate: false,
    })
    claim.socket = socket
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Live attach timeout")), 15_000)
      timer.unref()
      socket.on("open", () => {
        clearTimeout(timer)
        resolve()
      })
      socket.on("message", (data) => {
        try {
          const event: unknown = JSON.parse(data.toString())
          if (object(event)) this.event(claim, object(event)!)
        } catch {
          claim.context.gap()
          claim.failed("Live control data could not be verified. Review the task before continuing.")
        }
      })
      const closed = () => {
        clearTimeout(timer)
        reject(new Error("Live sideband closed"))
        if (!claim.cancelled && !claim.final) {
          claim.context.gap()
          claim.failed("Live control disconnected. Existing task work has not been cancelled.")
          void this.stop(claim.input.requestID)
        }
      }
      socket.on("error", closed)
      socket.on("close", closed)
    })
  }

  private event(claim: Claim, event: Record<string, unknown>) {
    if (event.type === "session.closed") {
      this.finalize(claim, event)
      return
    }
    if (claim.cancelled) return
    if (event.type === "session.started") {
      const session = object(event.session)
      if (!session || session.id !== claim.remote || session.model !== "gpt-live-1") {
        claim.failed("Live startup identity was not confirmed.")
        void this.stop(claim.input.requestID)
        return
      }
      if (!claim.started) {
        claim.started = true
        clearTimeout(claim.watch)
        claim.config!.started()
      }
      return
    }
    if (claim.commands.receive(event)) return
    if (event.type === "error") {
      claim.failed("OpenAI could not complete a Live operation. Review the existing task before retrying.")
      return
    }
    const changed = claim.context.receive(event)
    if (changed === "invalid" || changed === "limit") {
      claim.failed(
        "Live captions are incomplete or at their limit. Automatic delegation is unavailable; existing work continues.",
      )
      return
    }
    if (changed !== "delegation" || !claim.started) return
    const delegation = object(event.delegation)
    if (!delegation || !id(delegation.id) || claim.calls.has(delegation.id)) return
    const key = delegation.id
    claim.calls.add(key)
    claim.queue = claim.queue
      .then(async () => {
        this.assert(claim)
        const context = claim.context.select(key)
        if (!context) {
          await claim.commands.append(`clarify_${randomBytes(8).toString("hex")}`, "session.commentary.append", {
            delegation_id: key,
            content:
              "I do not have enough reliable new request context. Please clarify the task. Existing work has not been repeated.",
          })
          return
        }
        await this.work(claim, context)
      })
      .catch(() => {
        if (this.current(claim))
          claim.failed("Live work could not be confirmed. Review the task; this delegation will not be replayed.")
      })
  }

  private async work(claim: Claim, context: NonNullable<ReturnType<LiveContext["select"]>>) {
    const binding = claim.binding!
    const images: string[] = []
    for (const [id, image] of claim.images) if ((await image.result).status === "staged") images.push(id)
    this.assert(claim)
    const expected = `liv_${createHash("sha256").update(context.delegation).digest("hex").slice(0, 48)}`
    let result = await this.backend(claim, `/live/session/${encodeURIComponent(binding.id)}/calls`, {
      method: "POST",
      body: JSON.stringify({ generation: binding.generation, context, ...(images.length ? { images } : {}) }),
    })
    const initial = receipt(result, claim, expected)
    const deadline = Date.now() + 30 * 60_000
    while (result.status === "accepted" || result.status === "running") {
      if (Date.now() >= deadline) throw new Error("Live work remains unresolved")
      await delay(claim.abort.signal)
      result = await this.backend(claim, `/openai/session/${encodeURIComponent(binding.id)}/calls/${expected}`, {
        method: "GET",
      })
      receipt(result, claim, expected, initial)
    }
    this.assert(claim)
    if (!["completed", "failed", "cancelled", "unknown"].includes(String(result.status)))
      throw new Error("Invalid Live work result")
    const output = object(result.result)
    const text =
      result.status === "completed" && typeof output?.text === "string"
        ? output.text.slice(0, 1000)
        : `The task status is ${String(result.status)}. Review the task conversation for details; do not automatically repeat it.`
    await claim.commands.append(`result_${randomBytes(8).toString("hex")}`, "session.commentary.append", {
      delegation_id: context.delegation,
      content: text,
    })
  }

  private async stage(
    claim: Claim,
    id: string,
    data: string,
  ): Promise<{ status: "staged" | "unknown" | "failed"; error?: string }> {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(data)
    if (!match || match[2]!.length > 349528)
      return { status: "failed", error: "Select a supported image of at most 256 KiB." }
    try {
      const staged = await this.backend(claim, `/openai/session/${encodeURIComponent(claim.binding!.id)}/images`, {
        method: "POST",
        body: JSON.stringify({ generation: claim.binding!.generation, id, mime: match[1], data: match[2] }),
      })
      if (
        staged.id !== id ||
        staged.sha256 !== createHash("sha256").update(Buffer.from(match[2]!, "base64")).digest("hex")
      )
        throw new Error("Image receipt mismatch")
      this.assert(claim)
      // Only the backend receives image bytes. This update cannot itself dispatch work.
      void claim.commands.append(`image_${id}`, "session.thinking.append", {
        delegation_id: null,
        content:
          "The user selected an image for the Raya task backend. You cannot see the image directly. Delegate when the user asks about it; use only returned visual findings.",
      })
      return { status: "staged" }
    } catch {
      return {
        status: "unknown",
        error: "Image staging was not confirmed. Select a new image for another explicit attempt.",
      }
    }
  }

  private meter(claim: Claim, event: Record<string, unknown>, seconds: unknown) {
    if (!claim.binding) return
    claim.recording = this.backend(
      claim,
      `/live/session/${encodeURIComponent(claim.binding.id)}/duration`,
      {
        method: "POST",
        body: JSON.stringify({
          generation: claim.binding.generation,
          receipt: { id: event.event_id, model: "gpt-live-1", seconds },
        }),
      },
      true,
    )
      .then((receipt) => {
        if (receipt.id !== event.event_id || receipt.seconds !== seconds || receipt.model !== "gpt-live-1")
          throw new Error("Duration receipt mismatch")
        claim.usage = { ...claim.usage!, recorded: true }
        claim.config?.usage?.(claim.usage)
      })
      .catch(() => {
        claim.usage = { ...claim.usage!, incomplete: true }
        claim.config?.usage?.(claim.usage)
      })
  }

  private replay(claim: Claim, event: Record<string, unknown>) {
    if (event.event_id === claim.closure || !claim.usage || claim.usage.incomplete) return
    claim.usage = { ...claim.usage, incomplete: true }
    claim.config?.usage?.(claim.usage)
  }

  private finalize(claim: Claim, event: Record<string, unknown>) {
    const session = object(event.session)
    if (!session || session.id !== claim.remote || session.model !== "gpt-live-1" || !id(event.event_id)) return
    if (claim.final) return this.replay(claim, event)
    claim.final = true
    claim.closure = event.event_id
    const seconds = object(event.usage)?.seconds
    const valid = typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400
    claim.usage = {
      ...(valid ? { seconds } : {}),
      final: true,
      recorded: false,
      incomplete: !valid,
    }
    claim.config?.usage?.(claim.usage)
    if (!claim.usage.incomplete) this.meter(claim, event, seconds)
    claim.finalized?.()
    if (!claim.cancelled) {
      claim.failed("Live voice ended. Existing task work continues independently.")
      void this.stop(claim.input.requestID)
    }
  }

  private cleanup(claim: Claim) {
    return (claim.closing ??= this.close(claim))
  }
  private async close(claim: Claim): Promise<string | undefined> {
    claim.cancelled = true
    claim.abort.abort()
    clearInterval(claim.timer)
    clearTimeout(claim.watch)
    claim.commands.close()
    let released = !claim.remote
    if (claim.remote && !claim.final && claim.socket?.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000)
        timer.unref()
        claim.finalized = () => {
          clearTimeout(timer)
          resolve()
        }
        claim.socket!.send(
          JSON.stringify({ type: "session.close", event_id: `close_${randomBytes(8).toString("hex")}` }),
        )
      })
    }
    if (claim.final) released = true
    if (claim.remote && claim.config) {
      released =
        (await this.request(`${endpoint}/${encodeURIComponent(claim.remote)}/hangup`, {
          method: "POST",
          headers: { Authorization: `Bearer ${claim.config.key}` },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        })
          .then(async (response) => {
            await response.body?.cancel()
            return response.ok
          })
          .catch(() => false)) || released
    }
    if (!claim.final) {
      claim.usage = { final: false, recorded: false, incomplete: true }
      claim.config?.usage?.(claim.usage)
    }
    await claim.recording
    claim.socket?.terminate()
    const closed = claim.binding
      ? await this.backend(claim, `/openai/session/${encodeURIComponent(claim.binding.id)}`, { method: "DELETE" }, true)
          .then(
            (value) =>
              value.id === claim.binding!.id &&
              value.generation === claim.binding!.generation &&
              value.status === "closed",
          )
          .catch(() => false)
      : true
    if (!released || !closed || claim.uncertain)
      return "Live admission or cleanup remains unconfirmed. Restart Raya before reconnecting; review ongoing task work."
    if (this.claim === claim) this.claim = undefined
    return undefined
  }

  private async backend(claim: Claim, path: string, init: RequestInit, cleanup = false) {
    if (!cleanup) this.assert(claim)
    const cfg = claim.config!
    const url = new URL(`${cfg.backend.replace(/\/$/, "")}/kilocode/voice${path}`)
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
      throw new Error("Raya Live operation unconfirmed")
    }
    return json(response)
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
function reveal(cause: unknown) {
  if (!(cause instanceof Error) || cause.message.length === 0 || cause.message.length > 240) return undefined
  if (/bearer|sk-|password|authorization/i.test(cause.message)) return undefined
  return cause.message
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x20]/.test(value)
}
function sdp(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("v=0") && value.length <= 262144
}
function admission(value: Record<string, unknown>, claim: Claim): Binding {
  if (
    !id(value.id) ||
    !id(value.generation) ||
    value.parentSessionID !== claim.input.sessionID ||
    value.providerCallID !== claim.remote ||
    value.model !== "gpt-live-1" ||
    value.status !== "active" ||
    typeof value.directory !== "string" ||
    !sameDirectory(value.directory, claim.config!.directory)
  )
    throw new Error("Live binding mismatch")
  return value as Binding
}
function receipt(
  value: Record<string, unknown>,
  claim: Claim,
  call: string,
  initial?: { id: string; messageID: string },
) {
  if (
    value.callID !== call ||
    value.parentSessionID !== claim.input.sessionID ||
    typeof value.id !== "string" ||
    typeof value.messageID !== "string" ||
    !["accepted", "running", "completed", "failed", "cancelled", "unknown"].includes(String(value.status)) ||
    (initial && (value.id !== initial.id || value.messageID !== initial.messageID))
  )
    throw new Error("Live work receipt mismatch")
  if (value.status !== "completed") return { id: value.id, messageID: value.messageID }
  const result = object(value.result)
  if (
    !result ||
    typeof result.text !== "string" ||
    result.text.length > 12_000 ||
    !id(result.assistantMessageID) ||
    !Array.isArray(result.evidence) ||
    result.evidence.length > 64
  )
    throw new Error("Invalid Live work evidence")
  return { id: value.id, messageID: value.messageID }
}
async function json(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Missing response body")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 524288) throw new Error("Response too large")
      chunks.push(chunk.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    const result = object(value)
    if (!result) throw new Error("Invalid response")
    return result
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
function delay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Stopped"))
      return
    }
    const stop = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", stop)
      reject(new Error("Stopped"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop)
      resolve()
    }, 500)
    timer.unref()
    signal.addEventListener("abort", stop, { once: true })
  })
}
