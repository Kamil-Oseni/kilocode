import { describe, expect, it } from "bun:test"
import { createInputBuffer, createReplayGate } from "../../webview-ui/agent-manager/terminal/replay"

describe("Agent Manager terminal input buffer", () => {
  it("sends parser replies first while preserving user input order", () => {
    const input = createInputBuffer()
    input.add("early ")
    input.add("reply", true)
    input.add("command\r")

    expect(input.take()).toBe("replyearly command\r")
    expect(input.take()).toBe("")
  })

  it("caps user input and protocol replies independently", () => {
    const input = createInputBuffer(4)
    input.add("12345")
    input.add("abcde", true)

    expect(input.take()).toBe("bcde2345")
  })
})

describe("Agent Manager terminal replay gate", () => {
  it("flushes initial input only after replay parsing completes", () => {
    const events: string[] = []
    let complete: (() => void) | undefined
    const gate = createReplayGate({
      write: (data, callback) => {
        events.push(typeof data === "string" ? data : `bytes:${data.join(",")}`)
        if (callback) complete = callback
      },
      flush: () => events.push("flush"),
    })

    gate.attach(false)
    expect(gate.blocked()).toBe(true)
    gate.output("replay")
    gate.output(new Uint8Array([1, 2, 3]))
    expect(events).toEqual([])
    expect(gate.frame(new Uint8Array([0, 123, 125]))).toBe(true)
    expect(gate.blocked()).toBe(true)
    expect(gate.draining()).toBe(true)
    expect(events).toEqual(["replay", "bytes:1,2,3", ""])

    complete?.()
    expect(gate.blocked()).toBe(false)
    expect(gate.draining()).toBe(false)
    expect(events).toEqual(["replay", "bytes:1,2,3", "", "flush"])
  })

  it("buffers reconnect replay until metadata without blocking reconnect input", () => {
    const events: string[] = []
    const gate = createReplayGate({
      write: () => events.push("write"),
      flush: () => events.push("flush"),
    })

    gate.attach(true)
    expect(gate.blocked()).toBe(false)
    expect(gate.draining()).toBe(false)
    gate.output("live")
    expect(events).toEqual([])
    expect(gate.frame(new Uint8Array([0]))).toBe(true)
    expect(events).toEqual(["write"])
  })

  it("marks a truncated initial replay before the retained output", () => {
    const events: string[] = []
    const gate = createReplayGate({
      write: (data, callback) => {
        events.push(String(data))
        callback?.()
      },
      flush: () => events.push("flush"),
      gap: (value) => events.push(`gap:${value.requestedCursor}:${value.retainedFrom}:${value.retainedTo}`),
    })
    gate.attach(false)
    gate.output("retained tail")
    const meta = new TextEncoder().encode(
      '\0{"cursor":4000000,"replayGap":{"requestedCursor":0,"retainedFrom":2000000,"retainedTo":4000000}}',
    )
    expect(gate.frame(meta)).toBe(true)
    expect(events).toEqual(["gap:0:2000000:4000000", "retained tail", "", "flush"])
  })

  it("marks a truncated reconnect before replay and flushes an interrupted replay", () => {
    const events: string[] = []
    const gate = createReplayGate({
      write: (data) => events.push(String(data)),
      flush: () => events.push("flush"),
      gap: () => events.push("gap"),
    })
    gate.attach(true)
    gate.output("retained tail")
    const meta = new TextEncoder().encode(
      '\0{"cursor":900,"replayGap":{"requestedCursor":100,"retainedFrom":400,"retainedTo":900}}',
    )
    gate.frame(meta)
    expect(events).toEqual(["gap", "retained tail"])
    gate.attach(true)
    gate.output("partial replay")
    gate.end()
    expect(events).toEqual(["gap", "retained tail", "partial replay"])
    expect(gate.blocked()).toBe(false)
  })

  it("bounds output before metadata and reports local loss before the retained tail", () => {
    const events: string[] = []
    const gate = createReplayGate({
      write: (data) => events.push(`write:${String(data).length}`),
      flush: () => events.push("flush"),
      overflow: () => events.push("lost"),
    })
    gate.attach(false)
    gate.output("a".repeat(5 * 1024 * 1024))
    gate.output("tail")
    expect(gate.blocked()).toBe(true)
    expect(gate.frame(new Uint8Array([0, 123, 125]))).toBe(true)
    expect(events).toEqual(["lost", "write:4", "write:0"])
    expect(gate.blocked()).toBe(true)
  })

  it("does not release initial user input if the socket ends before metadata", () => {
    const events: string[] = []
    const gate = createReplayGate({
      write: (data) => events.push(String(data)),
      flush: () => events.push("flush"),
    })
    gate.attach(false)
    gate.output("partial")
    gate.end()
    expect(events).toEqual(["partial"])
    expect(gate.blocked()).toBe(true)
  })

  it("caps the number of tiny pre-metadata frames", () => {
    let writes = 0
    let losses = 0
    const gate = createReplayGate({
      write: () => writes++,
      flush: () => undefined,
      overflow: () => losses++,
    })
    gate.attach(true)
    for (let index = 0; index < 300; index++) gate.output("")
    gate.frame(new Uint8Array([0, 123, 125]))
    expect(writes).toBe(256)
    expect(losses).toBe(1)
  })

  it("consumes only one initial replay boundary", () => {
    let drains = 0
    const gate = createReplayGate({
      write: (_data, callback) => {
        if (callback) drains++
      },
      flush: () => undefined,
    })

    gate.attach(false)
    expect(gate.frame(new Uint8Array())).toBe(false)
    expect(gate.frame(new Uint8Array([0]))).toBe(true)
    expect(gate.frame(new Uint8Array([0]))).toBe(true)
    expect(drains).toBe(1)
  })

  it("ignores an initial parse callback after reconnect starts", () => {
    let complete: (() => void) | undefined
    let flushed = 0
    const gate = createReplayGate({
      write: (_data, callback) => {
        if (callback) complete = callback
      },
      flush: () => flushed++,
    })

    gate.attach(false)
    gate.frame(new Uint8Array([0]))
    gate.attach(true)
    complete?.()

    expect(gate.blocked()).toBe(false)
    expect(flushed).toBe(0)
  })

  it("lets terminal replies pass while queued replay parses before user input flushes", () => {
    const events: string[] = []
    let complete: (() => void) | undefined
    const gate = createReplayGate({
      write: (data, callback) => {
        events.push(String(data))
        if (callback) complete = callback
      },
      flush: () => events.push("flush"),
    })

    gate.attach(false)
    expect(gate.blocked()).toBe(true)
    gate.output("replay")
    gate.frame(new Uint8Array([0]))
    expect(gate.blocked()).toBe(true)
    expect(gate.draining()).toBe(true)
    gate.output("terminal-reply")
    expect(events).toEqual(["replay", "", "terminal-reply"])
    expect(complete).toBeFunction()
    complete?.()
    expect(gate.blocked()).toBe(false)
    expect(gate.draining()).toBe(false)
    expect(events).toEqual(["replay", "", "terminal-reply", "flush"])
  })

  it("keeps user input blocked for the complete parser-drain window", () => {
    let complete: (() => void) | undefined
    const gate = createReplayGate({
      write: (_data, callback) => {
        if (callback) complete = callback
      },
      flush: () => undefined,
    })

    gate.attach(false)
    gate.frame(new Uint8Array([0]))
    expect(gate.blocked()).toBe(true)
    expect(gate.draining()).toBe(true)

    complete?.()
    expect(gate.blocked()).toBe(false)
    expect(gate.draining()).toBe(false)
  })
})
