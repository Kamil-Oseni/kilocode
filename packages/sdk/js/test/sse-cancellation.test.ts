import { expect, test } from "bun:test"
import { sse } from "../script/sse"
import type { createSseClient } from "../src/v2/gen/core/serverSentEvents.gen"

const original = await Bun.file(
  new URL("../node_modules/@hey-api/openapi-ts/dist/clients/core/serverSentEvents.ts", import.meta.url),
).text()
const source = sse(original)
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source)
const client: typeof createSseClient = (
  await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"))
).createSseClient

test("checked generator patch refuses changed or already patched output", () => {
  expect(() => sse(source)).toThrow("exact generator output")
  expect(() => sse(original.replace("reader.cancel();", "reader.cancel('changed');"))).toThrow("exact generator output")
})

test("actual SSE abort joins the original reader without reporting a successful cancellation as failure", async () => {
  const signal = new AbortController()
  const errors: unknown[] = []
  const cancelled = Promise.withResolvers<void>()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"test":true}\n\n'))
    },
    cancel() {
      cancelled.resolve()
    },
  })
  const result = client({
    url: "http://localhost/controlled",
    signal: signal.signal,
    sseMaxRetryAttempts: 1,
    onSseError: (error) => errors.push(error),
    fetch: Object.assign(async () => new Response(stream), { preconnect: () => undefined }),
  })
  expect((await result.stream.next()).done).toBe(false)
  const next = result.stream.next()
  signal.abort()
  expect(await next).toEqual({ value: undefined, done: true })
  await cancelled.promise
  expect(errors).toEqual([])
})

test("actual SSE stream joins cancellation of an already failed read", async () => {
  const signal = new AbortController()
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()
  const errors: unknown[] = []
  const result = client({
    url: "http://localhost/controlled",
    signal: signal.signal,
    sseMaxRetryAttempts: 1,
    onSseError: (error) => errors.push(error),
    fetch: Object.assign(async () => new Response(stream.readable), { preconnect: () => undefined }),
  })
  const first = result.stream.next()
  await writer.write(new TextEncoder().encode('data: {"test":true}\n\n'))
  expect(await first).toEqual({ value: { test: true }, done: false })
  const next = result.stream.next()
  const failure = new Error("controlled read failure")
  await writer.abort(failure)
  signal.abort()
  expect(await next).toEqual({ value: undefined, done: true })
  expect(errors).toEqual([failure])
})

test("actual SSE stream retains different validation and cancellation failures", async () => {
  const signal = new AbortController()
  const primary = new Error("controlled validation failure")
  const cleanup = new Error("controlled cancellation failure")
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const errors: unknown[] = []
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()
  const result = client({
    url: "http://localhost/controlled",
    signal: signal.signal,
    sseMaxRetryAttempts: 1,
    onSseError: (error) => errors.push(error),
    responseValidator: async () => {
      ready.resolve()
      await release.promise
      throw primary
    },
    fetch: Object.assign(async () => new Response(stream.readable), { preconnect: () => undefined }),
  })
  const next = result.stream.next()
  await writer.write(new TextEncoder().encode('data: {"test":true}\n\n'))
  await ready.promise
  await writer.abort(cleanup)
  signal.abort()
  release.resolve()
  expect(await next).toEqual({ value: undefined, done: true })
  expect(errors).toHaveLength(1)
  expect(errors[0]).toBeInstanceOf(AggregateError)
  if (!(errors[0] instanceof AggregateError)) throw new Error("Aggregate failure required")
  expect(errors[0].errors).toEqual([primary, cleanup])
})
