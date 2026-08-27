// raya_change - Milestone H authoritative backend Voice-turn accumulator
export class VoiceReplies {
  private readonly assistants = new Map<string, string>()
  private readonly parts = new Map<string, { messageID: string; text: string }>()
  private readonly spoken = new Set<string>()
  private pending = false
  private session: string | undefined

  mark() {
    this.pending = true
    this.session = undefined
  }

  cancel() {
    this.pending = false
    this.session = undefined
  }

  message(sessionID: string, role: string, messageID: string) {
    if (role !== "assistant") return
    this.assistants.set(sessionID, messageID)
    if (this.pending && !this.session) this.session = sessionID
  }

  part(
    sessionID: string,
    part: { id: string; messageID?: string; type: string; text?: string; synthetic?: boolean },
  ) {
    if (part.type !== "text" || !part.messageID) return
    const key = `${sessionID}:${part.id}`
    if (part.synthetic) {
      this.parts.delete(key)
      return
    }
    this.parts.set(key, { messageID: part.messageID, text: part.text ?? "" })
  }

  remove(sessionID: string, partID: string) {
    this.parts.delete(`${sessionID}:${partID}`)
  }

  complete(sessionID: string) {
    if (!this.pending || this.session !== sessionID) return
    const messageID = this.assistants.get(sessionID)
    if (!messageID || this.spoken.has(messageID)) return
    const text = [...this.parts.entries()]
      .filter(([key, part]) => key.startsWith(`${sessionID}:`) && part.messageID === messageID)
      .map(([, part]) => part.text)
      .join("")
      .trim()
    if (!text) return
    this.pending = false
    this.session = undefined
    this.spoken.add(messageID)
    return text
  }

  // raya_change - session idle can arrive just before synchronized final message parts
  async wait(sessionID: string, timeout = 1_500) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      const text = this.complete(sessionID)
      if (text) return text
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
  }
}
