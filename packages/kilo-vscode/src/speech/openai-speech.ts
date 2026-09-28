import { createHash, randomBytes } from "node:crypto"
import { cancelled } from "../shared/voice-interruption"

type Work = { id: string; started: number; rung: number; background: boolean; status?: "accepted" | "running" }
type Request = { id: string; kind: "narration" | "result"; response?: string; deliveries?: string[] }
type Narration = Readonly<{
  version: 1
  started: number
  rung: number
  background: boolean
  status?: "accepted" | "running"
}>
type Delivery = {
  deadline: number
  phase: "pending" | "accepted" | "generated" | "uncertain"
  hash: string
  assigned: boolean
  settled: boolean
}
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
  private epoch = 0
  private fault = false
  private held = false
  private responses = new Set<string>()
  private playback = new Set<string>()
  private requests = new Map<string, Request>()
  private outputs = new Map<string, { call?: string; hash: string; cancel: () => void; semantic?: true }>()
  private deliveries = new Map<string, Delivery>()
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

  /** Audio eligibility only; backend work and call authority require separate checks. */
  boundary() {
    return Object.freeze({
      version: 1 as const,
      epoch: this.epoch,
      quiet:
        !this.closed &&
        !this.fault &&
        !this.uncertain &&
        this.current() &&
        !this.speaking &&
        !this.turn &&
        !this.request &&
        !this.pending &&
        !this.responses.size &&
        !this.playback.size &&
        !this.outputs.size,
    })
  }

  private activity(fault = false) {
    if (this.epoch < Number.MAX_SAFE_INTEGER) this.epoch++
    else this.fault = true
    if (fault) this.fault = true
  }

  /** Pause new presentation requests without hiding observed provider activity. */
  hold(value: boolean) {
    if (this.closed || this.held === value) return
    this.held = value
    this.activity()
  }

  generating(id: string) {
    return this.responses.has(id)
  }

  start(id: string) {
    if (this.closed) return
    this.activity(!identifier(id))
    this.finish()
    const work: Work = { id, started: this.time.now(), rung: 0, background: false }
    this.work = work
    this.schedule(work)
  }

  private schedule(work: Work) {
    const elapsed = this.time.now() - work.started
    this.timers = thresholds
      .filter((ms) => ms > elapsed)
      .map((ms) =>
        this.time.after(() => {
          if (this.work !== work || this.closed) return
          this.flush()
        }, ms - elapsed),
      )
  }

  narration(): Narration | undefined {
    if (!this.work) return
    return Object.freeze({
      version: 1,
      started: this.work.started,
      rung: this.work.rung,
      background: this.work.background,
      ...(this.work.status ? { status: this.work.status } : {}),
    })
  }

  restore(id: string, value: Narration) {
    if (this.closed || !identifier(id) || !timing(value, this.time.now())) {
      this.activity(true)
      throw new Error("Inherited voice narration has an invalid timing boundary")
    }
    if (this.work?.id === id) {
      if (this.work.started !== value.started) {
        this.activity(true)
        throw new Error("Inherited voice narration changed its original timing identity")
      }
      const rung = Math.max(this.work.rung, value.rung)
      const background = this.work.background || value.background
      const status = this.work.status === "running" ? this.work.status : (value.status ?? this.work.status)
      if (this.work.rung === rung && this.work.background === background && this.work.status === status) return
      this.activity()
      this.work.rung = rung
      this.work.background = background
      this.work.status = status
      this.flush()
      return
    }
    this.finish()
    this.activity()
    const work: Work = {
      id,
      started: value.started,
      rung: value.rung,
      background: value.background,
      ...(value.status ? { status: value.status } : {}),
    }
    this.work = work
    this.schedule(work)
    this.flush()
  }

  semantic(id: string, text: string, deadline: number) {
    if (
      this.closed ||
      !identifier(id) ||
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text, "utf8") > 16_384 ||
      !Number.isFinite(deadline) ||
      deadline <= this.time.now() ||
      deadline - this.time.now() > 30_000 ||
      this.deliveries.size >= 64 ||
      this.deliveries.has(id) ||
      this.outputs.has(id)
    ) {
      this.activity(true)
      throw new Error("Inherited voice result has an invalid delivery boundary")
    }
    this.activity()
    const hash = createHash("sha256").update(text).digest("hex")
    const delivery: Delivery = { deadline, hash, phase: "pending", assigned: false, settled: false }
    this.deliveries.set(id, delivery)
    this.outputs.set(id, {
      semantic: true,
      hash,
      cancel: this.time.after(() => {
        if (this.closed || !this.outputs.has(id)) return
        this.outputs.delete(id)
        delivery.phase = "uncertain"
        this.uncertain = true
        this.activity(true)
        if (this.current()) this.failed("Inherited voice result delivery is unconfirmed. Review the conversation.")
      }, deadline - this.time.now()),
    })
  }

  delivery(id: string) {
    const value = this.deliveries.get(id)
    if (!value) return
    return Object.freeze({ phase: value.phase, deadline: value.deadline, providerSettled: value.settled })
  }

  observe(id: string, status: unknown) {
    if (this.work?.id !== id || (status !== "accepted" && status !== "running")) return
    if (this.work.status !== status) this.activity()
    this.work.status = status
    this.flush()
  }

  finish() {
    if (this.work) this.activity()
    for (const cancel of this.timers) cancel()
    this.timers = []
    this.work = undefined
  }

  result(id: string, call: string, output: string) {
    if (this.closed) return
    this.activity(!identifier(id) || !identifier(call))
    this.outputs.set(id, {
      call,
      hash: createHash("sha256").update(output).digest("hex"),
      cancel: this.time.after(() => {
        if (this.closed || !this.outputs.has(id)) return
        this.outputs.delete(id)
        this.activity(true)
        if (this.current()) this.failed("Voice result delivery is unconfirmed. Review the result in the conversation.")
      }, 30_000),
    })
  }

  private lifecycle(event: Record<string, unknown>) {
    if (["input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped"].includes(String(event.type)))
      this.activity(event.type === "input_audio_buffer.speech_stopped" && !this.speaking)
    if (
      ["output_audio_buffer.started", "output_audio_buffer.stopped", "output_audio_buffer.cleared"].includes(
        String(event.type),
      )
    )
      this.activity(
        !identifier(event.response_id) ||
          (event.type === "output_audio_buffer.stopped" && !this.playback.has(String(event.response_id))),
      )
    if (["response.created", "response.done"].includes(String(event.type))) {
      const response = record(event.response)
      this.activity(
        !identifier(response?.id) ||
          (event.type === "response.done" &&
            (!this.responses.has(String(response?.id)) ||
              !["completed", "failed", "cancelled", "incomplete"].includes(String(response?.status)))),
      )
    }
    if (event.type === "error" && !cancelled(event, this.cancellations)) this.activity(true)
  }

  /** Update gates first; the broker drains after processing completed work calls. */
  event(event: Record<string, unknown>) {
    if (this.closed) return false
    this.lifecycle(event)
    this.audio(event)
    if (event.type === "conversation.item.done" || event.type === "conversation.item.created") {
      const item = record(event.item)
      if (typeof item?.id === "string") this.acknowledge(item)
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
      this.held ||
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
    this.activity()
    this.closed = true
    this.finish()
    this.watchdog?.()
    this.watchdog = undefined
    this.pending = false
    this.request = undefined
    this.requests.clear()
    for (const output of this.outputs.values()) output.cancel()
    for (const delivery of this.deliveries.values()) if (!delivery.settled) delivery.phase = "uncertain"
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
    if (["output_audio_buffer.stopped", "output_audio_buffer.cleared"].includes(String(event.type))) {
      this.settled(event)
      this.playback.delete(String(event.response_id))
    }
  }

  private acknowledge(item: Record<string, unknown>) {
    const id = String(item.id)
    const output = this.outputs.get(id)
    if (!output) return
    if (!acknowledged(item, output)) {
      this.activity(true)
      output.cancel()
      this.outputs.delete(id)
      const delivery = this.deliveries.get(id)
      if (delivery) {
        delivery.phase = "uncertain"
        this.uncertain = true
      }
      this.failed("Voice result acknowledgement did not match the work result. Review the conversation.")
      return
    }
    output.cancel()
    this.activity()
    this.outputs.delete(id)
    const delivery = this.deliveries.get(id)
    if (delivery) delivery.phase = "accepted"
    this.pending = true
  }

  private settled(event: Record<string, unknown>) {
    if (event.type === "output_audio_buffer.stopped" && !this.playback.has(String(event.response_id))) return
    const request = [...this.requests.values()].find((item) => item.response === event.response_id)
    for (const id of request?.deliveries ?? []) {
      const delivery = this.deliveries.get(id)!
      if (event.type === "output_audio_buffer.cleared") {
        delivery.phase = "uncertain"
        continue
      }
      delivery.settled = true
    }
  }

  private create(kind: Request["kind"], guidance?: string) {
    this.activity()
    const request: Request = { id: `raya_${randomBytes(12).toString("hex")}`, kind }
    if (kind === "result") {
      request.deliveries = [...this.deliveries]
        .filter(([, value]) => value.phase === "accepted" && !value.assigned)
        .map(([id]) => id)
      for (const id of request.deliveries) this.deliveries.get(id)!.assigned = true
    }
    this.request = request
    this.requests.set(request.id, request)
    if (this.requests.size > 256) this.requests.delete(this.requests.keys().next().value!)
    this.watchdog = this.time.after(() => {
      if (this.closed || this.request !== request || request.response) return
      // An unacknowledged request may already be producing audio. Never retry it.
      this.uncertain = true
      for (const id of request.deliveries ?? []) this.deliveries.get(id)!.phase = "uncertain"
      this.activity(true)
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
    for (const id of request.deliveries ?? []) this.deliveries.get(id)!.phase = "uncertain"
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

  private delivered(request: Request | undefined, response: Record<string, unknown>) {
    const valid =
      request?.response === response.id && this.responses.has(String(response.id)) && !this.uncertain && !this.fault
    for (const id of request?.deliveries ?? []) {
      const delivery = this.deliveries.get(id)!
      if (delivery.phase !== "uncertain")
        delivery.phase = valid && response.status === "completed" ? "generated" : "uncertain"
      if (!valid) this.uncertain = true
    }
  }

  private done(response: Record<string, unknown>) {
    const request = this.owned(response)
    this.delivered(request, response)
    this.responses.delete(String(response.id))
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
      const delivery = this.deliveries.get(error.event_id)
      if (delivery) {
        delivery.phase = "uncertain"
        this.uncertain = true
      }
      this.outputs.get(error.event_id)!.cancel()
      this.outputs.delete(error.event_id)
      this.failed(
        "OpenAI could not receive a work result. Review the result in the conversation; work was not repeated.",
      )
      return true
    }
    if (!this.request || error?.event_id !== this.request.id) return false
    for (const id of this.request.deliveries ?? []) this.deliveries.get(id)!.phase = "uncertain"
    this.watchdog?.()
    this.watchdog = undefined
    this.request = undefined
    if (this.work) this.work.rung = 4
    this.failed("OpenAI could not complete a voice response. Work remains in the conversation; it was not repeated.")
    return true
  }
}

function timing(value: unknown, now: number): value is Narration {
  const row = record(value)
  if (!row || Object.keys(row).some((key) => !["version", "started", "rung", "background", "status"].includes(key)))
    return false
  if (
    row.version !== 1 ||
    typeof row.started !== "number" ||
    !Number.isFinite(row.started) ||
    row.started < 0 ||
    row.started > now ||
    typeof row.rung !== "number" ||
    !Number.isInteger(row.rung)
  )
    return false
  const elapsed = now - row.started
  return (
    row.rung >= 0 &&
    row.rung <= thresholds.filter((ms) => elapsed >= ms).length &&
    typeof row.background === "boolean" &&
    (!row.background || elapsed >= thresholds[3]) &&
    (row.status === undefined || row.status === "accepted" || row.status === "running")
  )
}

function acknowledged(item: Record<string, unknown>, output: { semantic?: true; hash: string; call?: string }) {
  if (!output.semantic)
    return (
      item.type === "function_call_output" &&
      item.call_id === output.call &&
      typeof item.output === "string" &&
      createHash("sha256").update(item.output).digest("hex") === output.hash
    )
  const content = Array.isArray(item.content) ? item.content : []
  const part = record(content[0])
  return (
    item.type === "message" &&
    item.role === "user" &&
    content.length === 1 &&
    part?.type === "input_text" &&
    typeof part.text === "string" &&
    createHash("sha256").update(part.text).digest("hex") === output.hash
  )
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
