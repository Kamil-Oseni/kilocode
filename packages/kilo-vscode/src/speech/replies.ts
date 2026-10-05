// raya_change - authoritative final reply bound to the original frontend playback request
import { diagnostics, type PlaybackDiagnostic } from "./diagnostics"

export class VoiceReplies {
  constructor(private readonly observer?: (row: PlaybackDiagnostic) => void) {}

  private readonly parts = new Map<string, { messageID: string; text: string; ended: boolean }>()
  private readonly spoken = new Set<string>()
  private readonly wakes = new Set<() => void>()
  private readonly seen = new Set<string>()
  private turn:
    | {
        requestId: string
        sessionID: string
        pending: boolean
        userID?: string
        messageID?: string
        ended?: boolean
        failed?: boolean
        idle?: boolean
        current?: () => boolean
        trace?: ReturnType<typeof diagnostics>
        reason?: string
      }
    | undefined

  mark(input: { requestId: string; sessionID: string; current?: () => boolean }) {
    if (this.seen.has(input.requestId)) {
      if (this.turn?.requestId === input.requestId)
        this.turn.trace?.("handoff", { boundary: "refused", reason: "duplicate" })
      return false
    }
    this.turn?.trace?.("handoff", { boundary: "cancel", reason: "replaced" })
    this.seen.add(input.requestId)
    this.parts.clear()
    const trace = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)
      ? diagnostics(input.requestId, this.observer)
      : undefined
    this.turn = { requestId: input.requestId, sessionID: input.sessionID, current: input.current, pending: true, trace }
    trace?.("handoff", { boundary: "marker" })
    this.wake()
    return true
  }

  private wake() {
    for (const wake of this.wakes) wake()
    this.wakes.clear()
  }

  private refuse(reason: "unbound" | "foreign" | "nonterminal" | "missing-text" | "unended" | "spoken") {
    const turn = this.turn
    if (!turn || turn.reason === reason) return
    turn.reason = reason
    turn.trace?.("handoff", { boundary: "refused", reason })
  }

  private mismatch(sessionID: string, role: string) {
    const turn = this.turn
    if (role === "assistant" && turn?.pending && turn.sessionID === sessionID)
      this.refuse(turn.userID ? "foreign" : "unbound")
  }

  private progress(messageID: string, ended: boolean, failed: boolean) {
    const turn = this.turn
    if (!turn || (turn.messageID === messageID && (turn.ended || !ended) && (turn.failed || !failed))) return
    turn.trace?.("handoff", { boundary: "message", ended: !!(turn.ended || ended), failed: !!(turn.failed || failed) })
  }

  private absent(messageID?: string) {
    this.refuse(!this.turn?.userID ? "unbound" : messageID ? "spoken" : "nonterminal")
  }

  request() {
    return this.turn?.requestId
  }

  cancel(requestId?: string) {
    if (requestId && this.turn?.requestId !== requestId) return
    this.turn?.trace?.("handoff", { boundary: "cancel", reason: "cancelled" })
    this.turn = undefined
    this.parts.clear()
    this.wake()
  }

  capture(sessionID: string) {
    const turn = this.turn
    if (turn?.sessionID !== sessionID || !turn.pending || !(turn.current?.() ?? true)) return
    return turn.requestId
  }

  bind(sessionID: string, messageID: string, requestId: string) {
    const turn = this.turn
    if (!turn?.pending || turn.sessionID !== sessionID || turn.requestId !== requestId || !(turn.current?.() ?? true)) {
      if (turn?.requestId === requestId) turn.trace?.("handoff", { boundary: "refused", reason: "stale" })
      return false
    }
    if (turn.userID && turn.userID !== messageID) {
      turn.trace?.("handoff", { boundary: "refused", reason: "foreign" })
      return false
    }
    turn.userID = messageID
    turn.trace?.("handoff", { boundary: "bind" })
    return true
  }

  message(sessionID: string, role: string, messageID: string, parentID?: string, ended = false, failed = false) {
    const turn = this.turn
    if (
      role !== "assistant" ||
      turn?.sessionID !== sessionID ||
      !turn.pending ||
      !turn.userID ||
      parentID !== turn.userID
    ) {
      this.mismatch(sessionID, role)
      return
    }
    if ((turn.ended || turn.failed) && turn.messageID !== messageID) return
    this.progress(messageID, ended, failed)
    turn.messageID = messageID
    turn.ended = turn.ended || ended
    turn.failed = turn.failed || failed
    this.wake()
  }

  part(
    sessionID: string,
    part: {
      id: string
      messageID?: string
      type: string
      text?: string
      synthetic?: boolean
      time?: { start?: number; end?: number; created?: number }
    },
  ) {
    if (this.turn?.sessionID !== sessionID || !this.turn.pending || part.type !== "text" || !part.messageID) return
    const key = `${sessionID}:${part.id}`
    if (part.synthetic) {
      this.parts.delete(key)
      this.wake()
      return
    }
    const prior = this.parts.get(key)
    const ended = typeof part.time?.end === "number"
    this.parts.set(key, { messageID: part.messageID, text: part.text ?? "", ended })
    if (!prior || prior.ended !== ended)
      this.turn.trace?.("handoff", { boundary: "text", ended, parts: this.parts.size })
    this.wake()
  }

  remove(sessionID: string, partID: string) {
    this.parts.delete(`${sessionID}:${partID}`)
    this.wake()
  }

  complete(sessionID: string) {
    const turn = this.turn
    if (!turn?.pending || turn.sessionID !== sessionID || !(turn.current?.() ?? true)) return
    const messageID = turn.messageID
    if (!messageID || this.spoken.has(messageID)) {
      this.absent(messageID)
      return
    }
    if (!turn.ended && !turn.failed) {
      this.refuse("nonterminal")
      return
    }
    const parts = [...this.parts.entries()].filter(
      ([key, part]) => key.startsWith(`${sessionID}:`) && part.messageID === messageID,
    )
    if (!turn.failed && (!parts.length || parts.some(([, part]) => !part.ended))) {
      this.refuse(parts.length ? "unended" : "missing-text")
      return
    }
    const text = turn.failed
      ? ""
      : parts
          .map(([, part]) => part.text)
          .join("")
          .trim()
    turn.pending = false
    this.parts.clear()
    this.spoken.add(messageID)
    turn.trace?.("handoff", { boundary: "consume", failed: !!(turn.failed || !text), parts: parts.length })
    this.wake()
    return {
      requestId: turn.requestId,
      text,
      failed: turn.failed || !text,
      current: () => this.turn === turn && (turn.current?.() ?? true),
    }
  }

  busy(sessionID: string) {
    if (this.turn?.sessionID !== sessionID) return
    this.turn.idle = false
    this.wake()
  }

  // Idle and terminal snapshots may arrive in either order. Retain the exact turn
  // until its terminal message/text join, cancellation, or replacement; never poll.
  async wait(sessionID: string) {
    const turn = this.turn
    if (!turn || turn.sessionID !== sessionID) return
    turn.trace?.("handoff", { boundary: "wait" })
    turn.idle = true
    this.wake()
    while (this.turn === turn && turn.pending && (turn.current?.() ?? true)) {
      const reply = turn.idle || turn.failed ? this.complete(sessionID) : undefined
      if (reply) return reply
      await new Promise<void>((resolve) => this.wakes.add(resolve))
    }
  }
}
