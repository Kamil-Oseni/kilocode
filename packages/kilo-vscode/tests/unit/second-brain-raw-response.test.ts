import { expect, test } from "bun:test"
import { raw } from "../../src/second-brain/raw-response"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(type = "application/json", failure?: Error) {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{"synthetic":true}'))
        controller.close()
      },
    }),
    { headers: { "Content-Type": type } },
  )
  const body = response.body!
  const reader = body.getReader()
  const cancel = reader.cancel.bind(reader)
  const entered = deferred()
  const barrier = deferred()
  // Delay only the genuine reader's original cleanup completion. All reads,
  // cancel and release use the real native Response reader, not business mocks.
  Object.defineProperty(reader, "cancel", {
    value: async () => {
      await cancel()
      entered.resolve()
      await barrier.promise
      if (failure) throw failure
    },
  })
  Object.defineProperty(body, "getReader", { value: () => reader })
  return { response, body, entered, barrier }
}

test("abort during original reader cleanup waits for release and refuses successful bytes", async () => {
  const value = fixture()
  const signal = new AbortController()
  const failure = new Error("cancelled during cleanup")
  let settled = false
  const job = raw(value.response, signal.signal).finally(() => {
    settled = true
  })
  try {
    await value.entered.promise
    signal.abort(failure)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(value.body.locked).toBe(true)
    value.barrier.resolve()
    await expect(job).rejects.toBe(failure)
    expect(value.body.locked).toBe(false)
  } finally {
    value.barrier.resolve()
    await job.catch(() => undefined)
  }
})

test("primary and cleanup failure precede cancellation after original reader release", async () => {
  const cleanup = new Error("original cleanup failure")
  const value = fixture("text/plain", cleanup)
  const signal = new AbortController()
  const job = raw(value.response, signal.signal)
  try {
    await value.entered.promise
    signal.abort(new Error("later cancellation"))
    value.barrier.resolve()
    const result = await job.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors[0].code).toBe("invalid_response")
    expect((result as AggregateError).errors[1]).toBe(cleanup)
    expect(value.body.locked).toBe(false)
  } finally {
    value.barrier.resolve()
    await job.catch(() => undefined)
  }
})
