type Result = { status: "accepted" | "unknown" | "failed"; error?: string }
type Entry = {
  type: string
  content: string
  result: Promise<Result>
  resolve: (result: Result) => void
  timer: ReturnType<typeof setTimeout>
  done: boolean
}

/** Command acknowledgement is acceptance, never evidence of speech playback or task execution. */
export class LiveCommands {
  private entries = new Map<string, Entry>()
  constructor(
    private readonly send: (event: Record<string, unknown>) => void,
    private readonly wait = 15_000,
  ) {}

  append(id: string, type: string, body: Record<string, unknown> = {}) {
    const content = JSON.stringify(body)
    const prior = this.entries.get(id)
    if (prior)
      return prior.type === type && prior.content === content
        ? prior.result
        : Promise.resolve({ status: "failed" as const, error: "Voice command identity was reused." })
    if (this.entries.size >= 256)
      return Promise.resolve({
        status: "failed" as const,
        error: "Voice command limit reached. End voice before starting a fresh call.",
      })
    let resolve!: (result: Result) => void
    const result = new Promise<Result>((done) => {
      resolve = done
    })
    const timer = setTimeout(() => {
      const entry = this.entries.get(id)
      if (!entry || entry.done) return
      entry.done = true
      resolve({ status: "unknown", error: "Voice command acceptance was not confirmed." })
    }, this.wait)
    this.entries.set(id, { type, content, result, resolve, timer, done: false })
    try {
      this.send({ ...body, type, event_id: id })
    } catch {
      const entry = this.entries.get(id)
      if (entry) entry.done = true
      clearTimeout(timer)
      resolve({ status: "failed", error: "Voice command could not be sent." })
    }
    return result
  }

  receive(value: Record<string, unknown>) {
    const error = value.error && typeof value.error === "object" ? (value.error as Record<string, unknown>) : undefined
    const id = value.type === "error" ? (error?.event_id ?? value.client_event_id) : value.client_event_id
    if (typeof id !== "string") return false
    const entry = this.entries.get(id)
    if (!entry || entry.done) return false
    if (value.type === "error") {
      clearTimeout(entry.timer)
      entry.done = true
      entry.resolve({ status: "failed", error: "OpenAI rejected the voice command." })
      return true
    }
    const expected = entry.type.endsWith(".append") ? entry.type.replace(/\.append$/, ".appended") : `${entry.type}d`
    if (value.type !== expected) return false
    clearTimeout(entry.timer)
    entry.done = true
    entry.resolve({ status: "accepted" })
    return true
  }

  close() {
    for (const entry of this.entries.values()) {
      if (entry.done) continue
      entry.done = true
      clearTimeout(entry.timer)
      entry.resolve({ status: "unknown", error: "Voice ended before command acceptance was confirmed." })
    }
  }
}
