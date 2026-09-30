import type { ExportEvent } from "../events"

type Item = { sessionId: string; envelope: ExportEvent; bytes: number }

export class Inbox {
  private readonly capacity: number
  private items: Item[] = []
  private bytes = 0
  private reserved = new Set<Item>()
  private degraded = new Set<string>()

  constructor(opts: { capacityBytes: number }) {
    this.capacity = opts.capacityBytes
  }

  enqueue(
    sessionId: string,
    approxPayloadSize: string | number,
    envelope: ExportEvent,
  ): { accepted: boolean; sessionFirstOverflow: boolean } {
    const bytes = typeof approxPayloadSize === "number" ? approxPayloadSize : approxPayloadSize.length
    if (this.bytes + bytes > this.capacity) {
      const first = !this.degraded.has(sessionId)
      this.degraded.add(sessionId)
      return { accepted: false, sessionFirstOverflow: first }
    }
    this.items.push({ sessionId, envelope, bytes })
    this.bytes += bytes
    return { accepted: true, sessionFirstOverflow: false }
  }

  drainBatch(limit: number, capacity = Number.POSITIVE_INFINITY): Item[] {
    let bytes = 0
    let count = 0
    for (const item of this.items) {
      if (count >= limit || (count > 0 && bytes + item.bytes > capacity)) break
      bytes += item.bytes
      count += 1
    }
    const out = this.items.splice(0, count)
    for (const item of out) this.bytes -= item.bytes
    return out
  }

  restore(items: Item[]): void {
    this.items.unshift(...items)
    for (const item of items) {
      if (this.reserved.delete(item)) continue
      this.bytes += item.bytes
    }
  }

  take(limit: number, capacity: number): Item[] {
    const items = this.drainBatch(limit, capacity)
    for (const item of items) {
      this.reserved.add(item)
      this.bytes += item.bytes
    }
    return items
  }

  commit(items: Item[]): void {
    if (items.some((item) => !this.reserved.has(item))) throw new Error("Session export inbox batch is not reserved")
    for (const item of items) {
      this.reserved.delete(item)
      this.bytes -= item.bytes
    }
  }

  usedBytes(): number {
    return this.bytes
  }

  isDegraded(sessionId: string): boolean {
    return this.degraded.has(sessionId)
  }
}
