// raya_change - Dual speculative/authoritative transcript reconstruction for continuous voice events.
import type { MediaEvent, Turn } from "./protocol"

type MutableTurn = {
  -readonly [Key in keyof typeof Turn.Type]: (typeof Turn.Type)[Key]
}

export class VoiceReconstructor {
  private readonly turns = new Map<string, MutableTurn>()
  private readonly order: string[] = []
  private last = 0
  private incomplete = false

  constructor(initial?: { lastSeq: number; incomplete: boolean; turns: readonly (typeof Turn.Type)[] }) {
    if (!initial) return
    this.last = initial.lastSeq
    this.incomplete = initial.incomplete
    for (const turn of initial.turns) {
      this.order.push(turn.id)
      this.turns.set(turn.id, { ...turn })
    }
  }

  ingest(seq: number, event: typeof MediaEvent.Type) {
    if (this.last > 0 && seq !== this.last + 1) this.incomplete = true
    this.last = Math.max(this.last, seq)
    const role = event.type.includes("input") ? "user" : event.type.includes("output") ? "assistant" : undefined
    if (role && event.item) {
      const current = this.turns.get(event.item) ?? {
        id: event.item,
        role,
        speculative: "",
        stable: false,
        truncated: false,
        overlap: this.active(role === "user" ? "assistant" : "user"),
      }
      if (!this.turns.has(event.item)) this.order.push(event.item)
      if (event.type.endsWith(".delta")) current.speculative += event.text ?? ""
      if (event.type.endsWith(".done")) {
        current.authoritative = event.text ?? current.speculative
        current.speculative = current.authoritative
        current.stable = true
      }
      this.turns.set(event.item, current)
    }
    if (event.type === "response.interrupted") {
      const current = this.latest("assistant")
      if (current) {
        current.truncated = true
        current.heardMs = event.heardMs
        current.stable = false
        this.incomplete = true
      }
    }
    return this.state()
  }

  state() {
    return {
      lastSeq: this.last,
      incomplete: this.incomplete,
      turns: this.order.map((id) => this.turns.get(id)!),
    }
  }

  private active(role: "user" | "assistant") {
    const turn = this.latest(role)
    return !!turn && !turn.stable
  }

  private latest(role: "user" | "assistant") {
    return this.order
      .toReversed()
      .map((id) => this.turns.get(id)!)
      .find((turn) => turn.role === role)
  }
}
