import { expect, test } from "bun:test"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"

async function failure(body: ReadableStream<Uint8Array>) {
  const fetch = ollama({ localInferenceAPI: "ollama", localInference: true }, async () => new Response(body))
  const res = await fetch("http://localhost/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "fixture", messages: [], stream: true }),
  })
  return res.text().then(
    () => {
      throw new Error("Expected stream refusal")
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(OllamaBridgeError)
      if (!(err instanceof OllamaBridgeError)) throw err
      return err
    },
  )
}

test("ordinary conversion failure preserves independent cancellation error without leaking either body", async () => {
  const secret = "private-provider-body-should-not-appear"
  const cleanup = new TypeError(secret)
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ private: secret }) + "\n"))
    },
    cancel() {
      throw cleanup
    },
  })
  const err = await failure(body)
  expect(err.diagnostic).toMatchObject({
    reason: "ordinary-stream",
    stage: "frame",
    cleanup: "cancel",
    cancellation: "different",
    frames: 1,
  })
  expect(err.cause).toBeInstanceOf(AggregateError)
  if (!(err.cause instanceof AggregateError)) throw err
  const cause = err.cause
  expect(cause.errors[0]).toBeInstanceOf(OllamaBridgeError)
  expect(cause.errors[1]).toBe(cleanup)
  expect(err.message).not.toContain(secret)
  expect(JSON.stringify(err.diagnostic)).not.toContain(secret)
})

test("already errored native stream reports same original read/cancel error and retains both", async () => {
  const original = new TypeError("private-transport-error")
  const err = await failure(
    new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.error(original)
      },
    }),
  )
  expect(err.diagnostic).toMatchObject({
    reason: "ordinary-stream",
    stage: "read",
    error: "TypeError",
    cleanup: "cancel",
    cancellation: "same-primary",
    bytes: 0,
    frames: 0,
  })
  if (!(err.cause instanceof AggregateError)) throw err
  const cause = err.cause
  expect(cause.errors).toEqual([original, original])
  expect(cause.cause).toBe(original)
  expect(err.message).not.toContain(original.message)
})

test("unterminated stream stays refused with EOF classification and successful cancellation", async () => {
  const err = await failure(
    new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.close()
      },
    }),
  )
  expect(err.diagnostic).toMatchObject({
    reason: "ordinary-stream",
    stage: "eof",
    cleanup: "none",
    bytes: 0,
    frames: 0,
  })
  expect(err.diagnostic?.cancellation).toBeUndefined()
  expect(err.cause).toBeInstanceOf(OllamaBridgeError)
})

test("earlier emitted content is not misreported as zero on a later frame failure", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ model: "fixture", message: { role: "assistant", content: "prior-content" }, done: false }) +
      "\n{}\n",
  )
  const fetch = ollama(
    { localInferenceAPI: "ollama", localInference: true },
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(bytes)
            ctrl.close()
          },
        }),
      ),
  )
  const res = await fetch("http://localhost/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "fixture", messages: [], stream: true }),
  })
  const reader = res.body!.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain("prior-content")
  const err = await reader.read().then(
    () => undefined,
    (err: unknown) => err,
  )
  if (!(err instanceof OllamaBridgeError)) throw err
  expect(err.diagnostic).toMatchObject({ reason: "ordinary-stream", stage: "frame", frames: 2 })
  expect(err.diagnostic?.content).toBeUndefined()
  expect(err.message).not.toContain('"content":0')
})

test("non-LF final native frame is included in the refused EOF count", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ model: "fixture", message: { role: "assistant", content: "" }, done: false }),
  )
  const err = await failure(
    new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(bytes)
        ctrl.close()
      },
    }),
  )
  expect(err.diagnostic).toMatchObject({ reason: "ordinary-stream", stage: "eof", frames: 1, bytes: bytes.byteLength })
  expect(err.diagnostic?.content).toBeUndefined()
})
