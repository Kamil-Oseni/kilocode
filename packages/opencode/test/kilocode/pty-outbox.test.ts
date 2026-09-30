import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { makePtyOutbox } from "../../src/server/routes/instance/httpapi/handlers/pty"

describe("PTY WebSocket output backpressure", () => {
  test("caps queued frames, detaches once, and closes after every accepted frame", async () => {
    const wake = await Effect.runPromise(Queue.dropping<void>(1))
    let releases = 0
    const outbox = makePtyOutbox(wake, () => releases++)

    for (let n = 0; n < 256; n++) expect(outbox.offer(`frame-${n}`)).toBe(true)
    expect(outbox.offer("overflow")).toBe(false)
    expect(outbox.depth).toBe(257) // 256 accepted frames plus the reserved close frame
    expect(releases).toBe(1)
    expect(outbox.offer("later")).toBe(false)
    outbox.end(new Socket.CloseEvent(1000))
    expect(releases).toBe(1)

    for (let n = 0; n < 256; n++) expect(await Effect.runPromise(outbox.take)).toBe(`frame-${n}`)
    const close = await Effect.runPromise(outbox.take)
    expect(close).toBeInstanceOf(Socket.CloseEvent)
    if (!(close instanceof Socket.CloseEvent)) throw new Error("PTY did not close on overflow")
    expect(close.code).toBe(1013)
    expect(close.reason).toBe("terminal output backlog")
    expect(outbox.depth).toBe(0)
    expect(outbox.bytes).toBe(0)
  })

  test("caps UTF-8 bytes even when the frame count is low", async () => {
    const wake = await Effect.runPromise(Queue.dropping<void>(1))
    let releases = 0
    const outbox = makePtyOutbox(wake, () => releases++)
    const frame = "Ω".repeat(2_300_000) // 4.6 million UTF-8 bytes, not 2.3 million

    expect(outbox.offer(frame)).toBe(true)
    expect(outbox.bytes).toBe(Buffer.byteLength(frame))
    expect(outbox.offer(frame)).toBe(false)
    expect(outbox.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(releases).toBe(1)
    expect(await Effect.runPromise(outbox.take)).toBe(frame)
    expect(await Effect.runPromise(outbox.take)).toBeInstanceOf(Socket.CloseEvent)
  })

  test("admits the full retained replay at worst-case BMP UTF-8 width", async () => {
    const wake = await Effect.runPromise(Queue.dropping<void>(1))
    const outbox = makePtyOutbox(wake, () => {
      throw new Error("retained replay must fit")
    })
    const chunk = "界".repeat(64 * 1024)

    for (let n = 0; n < 32; n++) expect(outbox.offer(chunk)).toBe(true)
    expect(outbox.depth).toBe(32)
    expect(outbox.bytes).toBe(6 * 1024 * 1024)
    expect(outbox.closed).toBe(false)
  })

  test("normal exit closes once after accepted output", async () => {
    const wake = await Effect.runPromise(Queue.dropping<void>(1))
    const outbox = makePtyOutbox(wake, () => {
      throw new Error("unexpected detach")
    })

    expect(outbox.offer("done")).toBe(true)
    outbox.end(new Socket.CloseEvent(1000))
    expect(outbox.offer("late")).toBe(false)
    expect(await Effect.runPromise(outbox.take)).toBe("done")
    const close = await Effect.runPromise(outbox.take)
    expect(close).toBeInstanceOf(Socket.CloseEvent)
    if (!(close instanceof Socket.CloseEvent)) throw new Error("PTY did not close on exit")
    expect(close.code).toBe(1000)
  })
})
