import { createHash, randomBytes } from "node:crypto"
import { cancelled } from "../shared/voice-interruption"

type Work = { id: string; started: number; rung: number; background: boolean; status?: "accepted" | "running" }
type Request = { id: string; kind: "narration" | "result"; response?: string }
type Clock = {
  now: () => number
  after: (run: () => void, ms: number) => () => void
}

const clock: Clock = {
  now: () => performance.now(),
  after: (run, ms) => {
    const timer = setTimeout(run, ms)
    timer.unref()
    return () => clearTimeout(timer)
  },
}
const thresholds = [400, 1200, 2500, 5000]

/** One speech lane; none of its timers admit, repeat or cancel parent work. */
export class OpenAISpeech {
  private work?: Work
  private request?: Request
  private pending = false
  private speaking = false
  private turn = false
  private closed = false
  private uncertain = false
  private responses = new Set<string>()
  private playback = new Set<string>()
  private requests = new Map<string, Request>()
  private outputs = new Map<string, { call: string; hash: string; cancel: () => void }>()
  private silenced = new Set<string>()
  private cancellations = new Set<string>()
  private timers: (() => void)[] = []
  private watchdog?: () => void

  constructor(
    private readonly send: (event: Record<string, unknown>) => void,
    private readonly current: () => boolean,
    private readonly failed: (error: string) => void,
    private readonly time: Clock = clock,
  ) {}

  get output() {
    return [...this.playback].at(-1)
  }

  get background() {
    return this.work?.background ?? false
  }

  generating(id: string) {
    return this.responses.has(id)
  }

  start(id: string) {
    if (this.closed) return
    this.finish()
    const work: Work = { id, started: this.time.now(), rung: 0, background: false }
    this.work = work
    this.timers = thresholds.map((ms) =>
      this.time.after(() => {
        if (this.work !== work || this.closed) return
        this.flush()
      }, ms),
    )
  }

  observe(id: string, status: unknown) {
    if (this.work?.id !== id || (status !== "accepted" && status !== "running")) return
    this.work.status = status
    this.flush()
  }

  finish() {
    for (const cancel of this.timers) cancel()
    this.timers = []
    this.work = undefined
  }

  result(id: string, call: string, output: string) {
    if (this.closed) return
    this.outputs.set(id, {
      call,
      hash: createHash("sha256").update(output).digest("hex"),
      cancel: this.time.after(() => {
        if (this.closed || !this.outputs.has(id)) return
        this.outputs.delete(id)
        if (this.current()) this.failed("Voice result delivery is unconfirmed. Review the result in the conversation.")
      }, 30_000),
    })
  }

  /** Update gates first; the broker drains after processing completed work calls. */
  event(event: Record<string, unknown>) {
    if (this.closed) return false
    this.audio(event)
    if (event.type === "conversation.item.created") {
      const item = record(event.item)
      if (item?.type === "function_call_output" && typeof item.id === "string") this.acknowledge(item)
    }
    const response = record(event.response)
    if (event.type === "response.created" && response && identifier(response.id)) this.created(response)
    if (event.type === "response.done" && response && identifier(response.id)) return this.done(response)
    if (event.type === "error") return cancelled(event, this.cancellations) || this.error(record(event.error))
    return false
  }

  flush() {
    const work = this.work
    const elapsed = work ? this.time.now() - work.started : 0
    const rung = thresholds.filter((ms) => elapsed >= ms).length
    // Background is a local presentation transition, even while the user speaks.
    if (work && rung === 4) work.background = true
    if (
      this.closed ||
      this.uncertain ||
      !this.current() ||
      this.request ||
      this.responses.size ||
      this.playback.size ||
      this.speaking ||
      this.turn
    )
      return
    if (this.pending) {
      this.pending = false
      // A final result supersedes older holding speech, including a deferred rung.
      if (work) work.rung = rung
      this.create("result")
      return
    }
    if (!work?.status || !rung || rung <= work.rung) return
    work.rung = rung
    this.create("narration", guidance(work, rung))
  }

  close() {
    this.closed = true
    this.finish()
    this.watchdog?.()
    this.watchdog = undefined
    this.pending = false
    this.request = undefined
    this.requests.clear()
    for (const output of this.outputs.values()) output.cancel()
    this.outputs.clear()
    this.responses.clear()
    this.playback.clear()
    this.silenced.clear()
    this.cancellations.clear()
  }

  private audio(event: Record<string, unknown>) {
    if (event.type === "input_audio_buffer.speech_started") {
      this.speaking = true
      this.turn = true
      if (this.request?.response) this.silence(this.request)
    }
    if (event.type === "input_audio_buffer.speech_stopped") this.speaking = false
    if (event.type === "output_audio_buffer.started" && identifier(event.response_id)) {
      this.playback.add(event.response_id)
      const request = [...this.requests.values()].find((item) => item.response === event.response_id)
      if (request && (this.speaking || this.turn || this.silenced.has(event.response_id))) this.silence(request)
    }
    if (["output_audio_buffer.stopped", "output_audio_buffer.cleared"].includes(String(event.type)))
      this.playback.delete(String(event.response_id))
  }

  private acknowledge(item: Record<string, unknown>) {
    const id = String(item.id)
    const output = this.outputs.get(id)
    if (!output) return
    if (
      item.call_id !== output.call ||
      typeof item.output !== "string" ||
      createHash("sha256").update(item.output).digest("hex") !== output.hash
    ) {
      output.cancel()
      this.outputs.delete(id)
      this.failed("Voice result acknowledgement did not match the work result. Review the conversation.")
      return
    }
    output.cancel()
    this.outputs.delete(id)
    this.pending = true
  }

  private create(kind: Request["kind"], guidance?: string) {
    const request: Request = { id: `raya_${randomBytes(12).toString("hex")}`, kind }
    this.request = request
    this.requests.set(request.id, request)
    if (this.requests.size > 256) this.requests.delete(this.requests.keys().next().value!)
    this.watchdog = this.time.after(() => {
      if (this.closed || this.request !== request || request.response) return
      // An unacknowledged request may already be producing audio. Never retry it.
      this.uncertain = true
      if (this.current()) this.failed("Voice response delivery is unconfirmed. Work remains in the conversation.")
    }, 30_000)
    this.send({
      type: "response.create",
      event_id: request.id,
      response: {
        metadata: { raya_request: request.id, raya_kind: kind },
        tools: [],
        tool_choice: "none",
        ...(guidance
          ? {
              conversation: "none",
              output_modalities: ["audio"],
              max_output_tokens: 160,
              input: [],
              instructions: guidance,
            }
          : {}),
      },
    })
  }

  private owned(response: Record<string, unknown>) {
    const metadata = record(response.metadata)
    const request = typeof metadata?.raya_request === "string" ? this.requests.get(metadata.raya_request) : undefined
    if (request && metadata?.raya_kind === request.kind) return request
    return [...this.requests.values()].find((item) => item.response === response.id)
  }

  private created(response: Record<string, unknown>) {
    const id = String(response.id)
    this.responses.add(id)
    const request = this.owned(response)
    if (!request) {
      // Automatic VAD response owns this turn; do not race speech_stopped.
      this.turn = false
      return
    }
    if (request.response && request.response !== id) return
    request.response = id
    if (this.speaking || this.turn || this.responses.size > 1 || this.playback.size) this.silence(request)
    if (this.request !== request) return
    this.watchdog?.()
    this.watchdog = undefined
  }

  private silence(request: Request) {
    const id = request.response!
    this.silenced.add(id)
    const cancel = `${request.id}_cancel`
    if (this.responses.has(id) && !this.cancellations.has(cancel)) {
      this.cancellations.add(cancel)
      this.send({ type: "response.cancel", response_id: id, event_id: cancel })
    }
    const clear = `${request.id}_clear`
    if (this.output === id && !this.cancellations.has(clear)) {
      this.cancellations.add(clear)
      this.send({ type: "output_audio_buffer.clear", event_id: clear })
    }
    if (this.silenced.size > 256) this.silenced.delete(this.silenced.values().next().value!)
    while (this.cancellations.size > 512) this.cancellations.delete(this.cancellations.values().next().value!)
  }

  private done(response: Record<string, unknown>) {
    this.responses.delete(String(response.id))
    const request = this.owned(response)
    if (request === this.request && request && (!request.response || request.response === response.id)) {
      this.watchdog?.()
      this.watchdog = undefined
      this.request = undefined
      if (response.status === "failed" || response.status === "incomplete")
        this.failed(
          "OpenAI could not complete a voice response. Work remains in the conversation; it was not repeated.",
        )
    }
    return !!request || ["narration", "result"].includes(String(record(response.metadata)?.raya_kind))
  }

  private error(error?: Record<string, unknown>) {
    // Server event_id identifies the error event, not the rejected client request.
    if (typeof error?.event_id === "string" && this.outputs.has(error.event_id)) {
      this.outputs.get(error.event_id)!.cancel()
      this.outputs.delete(error.event_id)
      this.failed(
        "OpenAI could not receive a work result. Review the result in the conversation; work was not repeated.",
      )
      return true
    }
    if (!this.request || error?.event_id !== this.request.id) return false
    this.watchdog?.()
    this.watchdog = undefined
    this.request = undefined
    if (this.work) this.work.rung = 4
    this.failed("OpenAI could not complete a voice response. Work remains in the conversation; it was not repeated.")
    return true
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

function guidance(work: Work, rung: number) {
  const fact =
    work.status === "running" ? "The work is running in the existing conversation." : "The work was accepted."
  const style =
    rung === 1
      ? "Give only a very brief acknowledgement."
      : rung === 4
        ? "Briefly say this is taking longer, the user can keep talking, and the work remains in their conversation."
        : "Give one brief holding statement without repeating earlier acknowledgements."
  return (
    "You are Raya. Speak naturally and concisely in the user's language. " +
    `${style} The only verified fact is: ${fact} No result is available yet. ` +
    "Do not invent progress, a tool, a cause for delay, a completion time or an outcome. Do not ask to repeat the work."
  )
}
