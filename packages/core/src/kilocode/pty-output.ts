import { Effect, Queue } from "effect"
import * as Socket from "effect/unstable/socket/Socket"

export function makePtyOutbox(wake: Queue.Queue<void>, detach: () => void) {
  // The PTY retains up to 2 Mi UTF-16 code units; 8 MiB admits even worst-case
  // UTF-8 replay plus live output before forcing a reconnect.
  const limit = { count: 256, bytes: 8 * 1024 * 1024 }
  const pending: { item: string | Uint8Array | Socket.CloseEvent; bytes: number }[] = []
  let bytes = 0
  let closed = false
  const signal = () => void Queue.offerUnsafe(wake, undefined)
  const end = (event: Socket.CloseEvent) => {
    if (closed) return
    closed = true
    pending.push({ item: event, bytes: 0 }) // reserve one terminal slot beyond the data limit
    signal()
  }
  const offer = (item: string | Uint8Array) => {
    if (closed) return false
    const size = typeof item === "string" ? Buffer.byteLength(item) : item.byteLength
    if (pending.length >= limit.count || bytes + size > limit.bytes) {
      detach()
      end(new Socket.CloseEvent(1013, "terminal output backlog"))
      return false
    }
    pending.push({ item, bytes: size })
    bytes += size
    signal()
    return true
  }
  const take = Effect.gen(function* () {
    while (true) {
      yield* Queue.take(wake)
      const frame = pending.shift()
      if (!frame) continue
      bytes -= frame.bytes
      if (pending.length) signal()
      return frame.item
    }
  })
  return {
    offer,
    end,
    take,
    get closed() {
      return closed
    },
    get depth() {
      return pending.length
    },
    get bytes() {
      return bytes
    },
  }
}
