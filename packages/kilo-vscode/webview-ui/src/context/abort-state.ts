type Entry = {
  phase: "pending" | "active"
  messageID?: string
  source: "user-stop" | "user-escape"
}

export function createAbortState() {
  const entries = new Map<string, Entry>()

  return {
    request(id: string, status: string, messageID?: string, source: Entry["source"] = "user-stop") {
      const entry = entries.get(id)
      if (entry?.phase === "active") return status !== "idle"
      if (entry) return false
      if (status === "idle") {
        if (!messageID) return false
        entries.set(id, { phase: "pending", messageID, source })
        return false
      }
      entries.set(id, { phase: "active", source })
      return true
    },
    move(from: string, to: string) {
      const source = entries.get(from)
      if (!source) return
      entries.delete(from)
      const target = entries.get(to)
      if (target?.phase === "active") return
      entries.set(to, source)
    },
    update(id: string, status: string) {
      const entry = entries.get(id)
      if (!entry) return undefined
      if (status === "idle") {
        entries.delete(id)
        return undefined
      }
      if (entry.phase === "active") return undefined
      entries.set(id, { phase: "active", source: entry.source })
      return entry.source
    },
    finish(messageID: string) {
      for (const [id, entry] of entries) {
        if (entry.phase === "pending" && entry.messageID === messageID) entries.delete(id)
      }
    },
    clear(id: string) {
      entries.delete(id)
    },
  }
}
