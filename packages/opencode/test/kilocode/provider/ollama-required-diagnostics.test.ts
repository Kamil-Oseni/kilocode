import { expect, test } from "bun:test"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"
import { MessageV2 } from "@/session/message-v2"
import { ProviderV2 } from "@opencode-ai/core/provider"

const options = {
  localInference: true,
  localInferenceAPI: "ollama",
  localInferenceToolFormat: "completion-envelope-v1",
}
const marker = "private-error-and-payload-do-not-persist"
const request = {
  model: "fixture",
  messages: [{ role: "user", content: marker }],
  tools: [{ type: "function", function: { name: "update_goal", parameters: { type: "object" } } }],
  tool_choice: "auto",
  stream: true,
}

function inspect(err: unknown) {
  if (!(err instanceof OllamaBridgeError)) throw new Error("Expected strict bridge refusal")
  expect(err.isRetryable).toBe(false)
  expect(JSON.stringify(err)).not.toContain(marker)
  expect(err.message).toStartWith("Unsupported or invalid Ollama bridge request or response [")
  expect(err.message).not.toContain(marker)
  expect(err.message.length).toBeLessThan(400)
  const saved = MessageV2.fromError(err, { providerID: ProviderV2.ID.make("local") })
  const text = JSON.stringify(saved)
  expect(saved.name).toBe("UnknownError")
  expect(text).not.toContain(marker)
  expect(text).not.toContain("arguments")
  return JSON.parse(err.message.slice(err.message.indexOf(" [") + 2, -1))
}

test("real native HTTP outer JSON and UTF8 failures have distinct private-safe stages before any SSE", async () => {
  const bodies = [new TextEncoder().encode('{"message":"' + marker + "\n"), new Uint8Array([0xc3, 0x28])]
  const state = { index: 0, requests: 0, published: false }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.requests++
      return new Response(bodies[state.index])
    },
  })
  try {
    for (const index of [0, 1]) {
      state.index = index
      const err = await ollama(options, fetch)(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify(request),
      }).then(
        () => {
          state.published = true
        },
        (err: unknown) => err,
      )
      expect(state.published).toBe(false)
      const row = inspect(err)
      expect(row.reason).toBe(index ? "required-acquisition" : "required-frame-json")
      expect(row.stage).toBe(index ? "utf8" : "frame")
      expect(row.error).toBe(index ? "TypeError" : "SyntaxError")
      expect(row.bytes).toBe(bodies[index].byteLength)
      expect(row.frames).toBe(index ? 0 : 1)
      expect(row.content).toBe(0)
      expect(row.finish).toBe("missing")
      if (index) expect(row.cleanup).toBe("none")
    }
    expect(state.requests).toBe(2)
  } finally {
    await server.stop(true)
  }
})

test("actual prematurely closed HTTP body refuses acquisition without leaking transport cause", async () => {
  const body = JSON.stringify({ model: "fixture", message: { role: "assistant", content: marker }, done: false }) + "\n"
  const state = { requests: 0, published: false }
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        state.requests++
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body) + 1024}\r\nConnection: close\r\n\r\n${body}`,
        )
      },
    },
  })
  try {
    const err = await ollama(options, fetch)(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify(request),
    }).then(
      () => {
        state.published = true
      },
      (err: unknown) => err,
    )
    expect(state.published).toBe(false)
    const row = inspect(err)
    expect(row.reason).toBe("required-acquisition")
    expect(row.stage).toBe("read")
    expect(["Error", "TypeError", "other"]).toContain(row.error)
    expect(row.cleanup).toBe("cancel")
    expect(row.finish).toBe("missing")
    expect(row.bytes).toBeLessThanOrEqual(Buffer.byteLength(body))
    expect(row.frames).toBeLessThanOrEqual(1)
    expect(state.requests).toBe(1)
  } finally {
    server.stop(true)
  }
})

test("actual ReadableStream cancellation failure is sanitized and still releases its reader", async () => {
  const state = { canceled: 0, published: false }
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new Uint8Array([0xc3, 0x28]))
    },
    cancel() {
      state.canceled++
      throw new Error(marker)
    },
  })
  const send = ollama(options, async () => new Response(stream))
  const err = await send("http://127.0.0.1:1/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(request),
  }).then(
    () => {
      state.published = true
    },
    (err: unknown) => err,
  )
  expect(state.published).toBe(false)
  expect(inspect(err)).toEqual({
    reason: "required-acquisition",
    stage: "utf8",
    error: "TypeError",
    cleanup: "cancel",
    finish: "missing",
    bytes: 2,
    frames: 0,
    content: 0,
  })
  expect(state.canceled).toBe(1)
  expect(stream.locked).toBe(false)
})

test("caller abort stays the original error while pending actual stream acquisition is canceled", async () => {
  const ready = Promise.withResolvers<void>()
  const state = { canceled: 0 }
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      ready.resolve()
    },
    cancel() {
      state.canceled++
    },
  })
  const controller = new AbortController()
  const original = new Error(marker)
  const pending = ollama(options, async () => new Response(stream))("http://127.0.0.1:1/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(request),
    signal: controller.signal,
  })
  const joined = Promise.allSettled([pending])
  await ready.promise
  controller.abort(original)
  const rows = await joined
  expect(rows[0].status).toBe("rejected")
  if (rows[0].status === "rejected") expect(rows[0].reason).toBe(original)
  expect(state.canceled).toBe(1)
  expect(stream.locked).toBe(false)
})

test("actual reader errors cannot smuggle custom error names or private causes into serialized metadata", async () => {
  const original = new Error(marker, { cause: new Error(marker) })
  original.name = marker
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.error(original)
    },
  })
  const err = await ollama(options, async () => new Response(stream))("http://127.0.0.1:1/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(request),
  }).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(inspect(err)).toMatchObject({
    reason: "required-acquisition",
    stage: "read",
    error: "other",
    cleanup: "cancel",
    bytes: 0,
    frames: 0,
  })
  if (!(err instanceof Error) || !(err.cause instanceof AggregateError))
    throw new Error("Original cleanup evidence missing")
  expect(err.cause.errors).toContain(original)
  expect(stream.locked).toBe(false)
})

test("generic network errors retain their existing retryable serialization", () => {
  const original = Object.assign(new Error("Connection reset by server"), { code: "ECONNRESET" })
  const saved = MessageV2.fromError(original, { providerID: ProviderV2.ID.make("local") })
  expect(saved.name).toBe("APIError")
  if (saved.name !== "APIError") throw new Error("Generic network classification changed")
  expect(saved.data.isRetryable).toBe(true)
  expect(saved.data.message).toBe("Connection reset by server")
})
