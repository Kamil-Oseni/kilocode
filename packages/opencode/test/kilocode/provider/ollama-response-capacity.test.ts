import { expect, test } from "bun:test"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"

const bound = 2 * 1024 * 1024
const total = 64 * 1024 * 1024
const encoder = new TextEncoder()
const row = { model: "fixture", message: { role: "assistant", content: "" }, done: true }
const frame = (size: number, done = true) => {
  const value = { ...row, done, padding: "" }
  return JSON.stringify({ ...value, padding: "x".repeat(size - Buffer.byteLength(JSON.stringify(value))) })
}
async function drain(res: Response) {
  if (!res.body) throw new Error("Missing owned HTTP response")
  const reader = res.body.getReader()
  const state = { bytes: 0, done: false }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return state
      state.bytes += chunk.value.byteLength
      state.done ||= new TextDecoder().decode(chunk.value).includes("data: [DONE]")
    }
  } finally {
    reader.releaseLock()
  }
}
async function send(server: ReturnType<typeof Bun.serve>, stream: boolean, signal?: AbortSignal) {
  return ollama({ localInference: true, localInferenceAPI: "ollama" }, globalThis.fetch)(
    `${server.url}v1/chat/completions`,
    { method: "POST", signal, body: JSON.stringify({ model: "fixture", messages: [], stream }) },
  )
}

test("actual HTTP JSON success and error retain exact 2 MiB raw boundaries", async () => {
  const state = { size: bound, status: 200 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const body = state.status === 200 ? frame(state.size) : JSON.stringify({ error: "x".repeat(state.size - 12) })
      expect(Buffer.byteLength(body)).toBe(state.size)
      return new Response(body, { status: state.status })
    },
  })
  try {
    for (const status of [200, 400]) {
      state.status = status
      state.size = bound
      const res = await send(server, false)
      expect(res.status).toBe(status)
      await res.arrayBuffer()
      state.size = bound + 1
      expect(await send(server, false).catch((err: unknown) => err)).toBeInstanceOf(OllamaBridgeError)
    }
  } finally {
    await server.stop(true)
  }
})

test("actual HTTP ordinary frames accept exact boundary and refuse larger frames before parsing", async () => {
  const state = { size: bound }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(frame(state.size) + "\n")
    },
  })
  try {
    expect((await drain(await send(server, true))).done).toBe(true)
    state.size++
    const err = await drain(await send(server, true)).catch((err: unknown) => err)
    expect(err).toBeInstanceOf(OllamaBridgeError)
    if (!(err instanceof OllamaBridgeError)) throw err
    expect(err.diagnostic?.capacity).toBe("frame")
    expect(err.message).not.toContain("xxxxxxxxxx")
    expect(err.isRetryable).toBe(false)
  } finally {
    await server.stop(true)
  }
})

test("actual HTTP nonstream success and error malformed UTF8 are nonretryable protocol refusals", async () => {
  const state = { status: 200 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const prefix = encoder.encode(
        state.status === 200 ? '{"model":"fixture","message":{"role":"assistant","content":"' : '{"error":"',
      )
      const tail = encoder.encode(state.status === 200 ? '"},"done":true}' : '"}')
      return new Response(new Uint8Array([...prefix, 0xc3, 0x28, ...tail]), { status: state.status })
    },
  })
  try {
    for (const status of [200, 400]) {
      state.status = status
      const err = await send(server, false).catch((err: unknown) => err)
      expect(err).toBeInstanceOf(OllamaBridgeError)
      if (!(err instanceof OllamaBridgeError)) throw err
      expect(err.isRetryable).toBe(false)
      expect(err.cause).toBeInstanceOf(TypeError)
      expect(err.message).not.toContain("fixture")
    }
  } finally {
    await server.stop(true)
  }
})

test("actual HTTP nonstream caller abort preserves its exact reason while waiting for EOF", async () => {
  const ready = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      req.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(encoder.encode(JSON.stringify(row)))
            ready.resolve()
          },
        }),
      )
    },
  })
  try {
    const ctrl = new AbortController()
    const reason = new Error("private nonstream caller abort")
    const response = send(server, false, ctrl.signal).catch((err: unknown) => err)
    await ready.promise
    ctrl.abort(reason)
    expect(await response).toBe(reason)
    const timer = setTimeout(() => aborted.reject(new Error("Native HTTP cancellation missing")), 2000)
    await aborted.promise.finally(() => clearTimeout(timer))
  } finally {
    await server.stop(true)
  }
})

test("actual HTTP coalesced response exceeds 2 MiB while each frame remains bounded", async () => {
  const part = frame(64 * 1024, false) + "\n"
  const body = part.repeat(40) + JSON.stringify(row) + "\n"
  expect(Buffer.byteLength(body)).toBeGreaterThan(bound)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(body)
    },
  })
  try {
    expect((await drain(await send(server, true))).done).toBe(true)
  } finally {
    await server.stop(true)
  }
})

test("actual HTTP split Unicode survives and malformed or incomplete UTF8 is refused", async () => {
  const state = { mode: 0 }
  const bytes = encoder.encode(
    JSON.stringify({ ...row, message: { role: "assistant", content: "café 日本語" } }) + "\n",
  )
  const split = bytes.indexOf(0xc3) + 1
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(ctrl) {
            if (state.mode) {
              ctrl.enqueue(state.mode === 1 ? new Uint8Array([0xc3, 0x28]) : new Uint8Array([0xc3]))
              ctrl.close()
              return
            }
            ctrl.enqueue(bytes.subarray(0, split))
            await Bun.sleep(5)
            ctrl.enqueue(bytes.subarray(split))
            ctrl.close()
          },
        }),
      )
    },
  })
  try {
    expect(await (await send(server, true)).text()).toContain("café 日本語")
    for (const mode of [1, 2]) {
      state.mode = mode
      const err = await drain(await send(server, true)).catch((err: unknown) => err)
      expect(err).toBeInstanceOf(OllamaBridgeError)
      if (!(err instanceof OllamaBridgeError)) throw err
      expect(err.diagnostic?.stage).toBe("utf8")
    }
  } finally {
    await server.stop(true)
  }
})

test("actual HTTP aggregate boundary is 64 MiB and overflow preserves earlier emitted uncertainty", async () => {
  const state = { extra: 0 }
  // Reuse one 64 KiB frame. Neither endpoint nor consumer buffers the aggregate response.
  const part = encoder.encode(frame(64 * 1024 - 1, false) + "\n")
  const end = encoder.encode(JSON.stringify(row) + "\n")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const size = total + state.extra
      const cursor = { bytes: 0 }
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(ctrl) {
              const left = size - end.byteLength - cursor.bytes
              if (left > 0) {
                // Final whitespace is valid NDJSON and makes the raw capacity exact.
                const value = left >= part.byteLength ? part : new Uint8Array(left).fill(32)
                ctrl.enqueue(value)
                cursor.bytes += value.byteLength
                return
              }
              ctrl.enqueue(end)
              ctrl.close()
            },
          },
          { highWaterMark: 0 },
        ),
      )
    },
  })
  try {
    expect((await drain(await send(server, true))).done).toBe(true)
    state.extra = 1
    const res = await send(server, true)
    if (!res.body) throw new Error("Missing owned response")
    const reader = res.body.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(new TextDecoder().decode(first.value)).toContain("data:")
    const err = await (async () => {
      while (!(await reader.read()).done) {}
    })().catch((err: unknown) => err)
    reader.releaseLock()
    expect(err).toBeInstanceOf(OllamaBridgeError)
    if (!(err instanceof OllamaBridgeError)) throw err
    expect(err.diagnostic?.capacity).toBe("response")
    expect(err.diagnostic?.frames).toBeGreaterThan(0)
    expect(err.isRetryable).toBe(false)
  } finally {
    await server.stop(true)
  }
}, 30_000)

test("actual HTTP terminal frame cannot synthesize EOF and caller abort closes the native request", async () => {
  const aborted = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      req.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(encoder.encode(JSON.stringify(row) + "\n"))
          },
        }),
      )
    },
  })
  try {
    const ctrl = new AbortController()
    const res = await send(server, true, ctrl.signal)
    if (!res.body) throw new Error("Missing owned response")
    const reader = res.body.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).not.toContain("[DONE]")
    const next = reader.read()
    ctrl.abort(new Error("private owned cancellation"))
    expect(await next.catch((err: unknown) => err)).toBeInstanceOf(OllamaBridgeError)
    reader.releaseLock()
    const timer = setTimeout(() => aborted.reject(new Error("Native HTTP cancellation missing")), 2000)
    await aborted.promise.finally(() => clearTimeout(timer))
  } finally {
    await server.stop(true)
  }
})

test("actual HTTP empty lines consume the new 1,048,576-frame capacity", async () => {
  const state = { extra: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("\n".repeat(1_048_575 + state.extra) + JSON.stringify(row) + "\n")
    },
  })
  try {
    expect((await drain(await send(server, true))).done).toBe(true)
    state.extra = 1
    const err = await drain(await send(server, true)).catch((err: unknown) => err)
    expect(err).toBeInstanceOf(OllamaBridgeError)
    if (!(err instanceof OllamaBridgeError)) throw err
    expect(err.diagnostic?.capacity).toBe("frames")
    expect(err.isRetryable).toBe(false)
  } finally {
    await server.stop(true)
  }
})

test("actual HTTP non-LF final frame and queued DONE permit downstream cancellation after native EOF", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(JSON.stringify(row))
    },
  })
  try {
    const res = await send(server, true)
    if (!res.body) throw new Error("Missing owned response")
    const reader = res.body.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(new TextDecoder().decode(first.value)).not.toContain("[DONE]")
    await reader.cancel()
    expect((await reader.read()).done).toBe(true)
    reader.releaseLock()
  } finally {
    await server.stop(true)
  }
})

test("actual HTTP caller abort with idle queued frames retains refusal and joins later downstream cancellation", async () => {
  const aborted = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      req.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(encoder.encode(frame(256, false) + "\n" + frame(256, false) + "\n"))
          },
        }),
      )
    },
  })
  try {
    const ctrl = new AbortController()
    const res = await send(server, true, ctrl.signal)
    if (!res.body) throw new Error("Missing owned response")
    const reader = res.body.getReader()
    expect((await reader.read()).done).toBe(false)
    ctrl.abort(new Error("private idle cancellation"))
    const timer = setTimeout(() => aborted.reject(new Error("Native HTTP cancellation missing")), 2000)
    await aborted.promise.finally(() => clearTimeout(timer))
    const err = await reader.read().catch((err: unknown) => err)
    expect(err).toBeInstanceOf(OllamaBridgeError)
    if (!(err instanceof OllamaBridgeError)) throw err
    // Bun's aborted native reader rejects cancel with the original abort; that error must remain visible.
    expect(err.diagnostic?.cleanup).toBe("cancel")
    expect(err.cause).toBeInstanceOf(AggregateError)
    if (!(err.cause instanceof AggregateError)) throw err
    expect(err.cause.errors[0]).toBe(ctrl.signal.reason)
    expect(
      err.cause.errors.some((value: unknown) => value instanceof TypeError && value.message.includes("not attached")),
    ).toBe(false)
    expect(err.message).not.toContain("private idle cancellation")
    reader.releaseLock()
  } finally {
    await server.stop(true)
  }
})

test("owned native reader release fault is retained once with release diagnostics and no private message", async () => {
  const removal = new TypeError("private owned release failure")
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(JSON.stringify(row) + "\n"))
      ctrl.close()
    },
  })
  const res = new Response(body)
  if (!res.body) throw new Error("Missing owned response")
  const native = res.body.getReader()
  const release = native.releaseLock.bind(native)
  // Fault injection at the actual reader cleanup seam; parsing and bridge lifecycle stay real.
  Object.defineProperty(native, "releaseLock", {
    value() {
      throw removal
    },
  })
  Object.defineProperty(res.body, "getReader", {
    value() {
      return native
    },
  })
  try {
    const response = await ollama({ localInference: true, localInferenceAPI: "ollama" }, async () => res)(
      "http://127.0.0.1/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: "fixture", messages: [], stream: true }) },
    )
    const err = await drain(response).catch((err: unknown) => err)
    expect(err).toBeInstanceOf(OllamaBridgeError)
    if (!(err instanceof OllamaBridgeError)) throw err
    expect(err.diagnostic).toMatchObject({ stage: "release", cleanup: "release" })
    expect(err.cause).toBe(removal)
    expect(err.message).not.toContain(removal.message)
  } finally {
    release()
  }
})
