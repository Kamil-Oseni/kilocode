import { expect, test } from "bun:test"
import { ollama } from "@/kilocode/provider/ollama-bridge"

test("ordinary Ollama text cancellation during external owned body preparation prevents the actual HTTP leaf", async () => {
  const ready = Promise.withResolvers<void>()
  const ctrl = new AbortController()
  const reason = new Error("Owned request cancelled during body preparation")
  const raw = new TextEncoder().encode(JSON.stringify({ model: "fixture", messages: [] }))
  let held: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false
  let cancelled = 0
  let calls = 0
  let posts = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      held = controller
    },
    pull() {
      ready.resolve()
    },
    cancel() {
      cancelled++
    },
  })
  const release = () => {
    if (closed) return
    if (!held) throw new Error("Original body controller missing")
    held.enqueue(raw)
    held.close()
    closed = true
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      expect(req.method).toBe("POST")
      expect(new URL(req.url).pathname).toBe("/api/chat")
      posts++
      await req.arrayBuffer()
      return Response.json({
        model: "fixture",
        message: { role: "assistant", content: "fixture" },
        done: true,
        done_reason: "stop",
      })
    },
  })
  const original = new Request(`${server.url}v1/chat/completions`, { method: "POST", body, signal: ctrl.signal })
  const bridge = ollama({ localInference: true, localInferenceAPI: "ollama" }, async (input, init) => {
    calls++
    // A custom transport can ignore cancellation; the bridge must fence its invocation itself.
    return globalThis.fetch(input, { ...init, signal: undefined })
  })
  const result = (async () => {
    // The caller owns and settles the original streamed body; bridge Request-only bodies remain unsupported.
    const text = await original.text()
    return bridge(original, { method: "POST", body: text })
  })().then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  )
  try {
    await ready.promise
    ctrl.abort(reason)
    release()
    const terminal = await result
    expect({ calls, posts }).toEqual({ calls: 0, posts: 0 })
    expect(terminal.error).toBe(reason)
    expect(terminal.value).toBeUndefined()
    expect(original.bodyUsed).toBe(true)
    expect(closed).toBe(true)
    expect(cancelled).toBe(0)
  } finally {
    release()
    await result
    await server.stop()
  }
})
