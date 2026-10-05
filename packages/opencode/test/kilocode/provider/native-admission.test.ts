import { expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http"
import { LLMError } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { createLocalScheduler, LocalInferenceError } from "../../../src/kilocode/provider/local-scheduler"
import { terminal } from "../../../src/kilocode/provider/native-admission"
import { KiloSessionProcessor } from "../../../src/kilocode/session/processor"
import { SessionRetry } from "../../../src/session/retry"
import { MessageV2 } from "../../../src/session/message-v2"

for (const code of ["queue-full", "queue-timeout"] as const) {
  test(`actual native HTTP executor treats ${code} as terminal without its internal retries`, async () => {
    const starts: string[] = []
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const host = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        starts.push(new URL(request.url).pathname)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller
              controller.enqueue(new TextEncoder().encode("held native response"))
            },
          }),
        )
      },
    })
    const queue = createLocalScheduler({ count: 1, age: 100 })
    const abort = new AbortController()
    const first = await queue.fetch(fetch, new URL("held", host.url))
    const waiting =
      code === "queue-full"
        ? queue.fetch(fetch, new URL("waiting", host.url), { signal: abort.signal }).then(
            () => undefined,
            (err: unknown) => err,
          )
        : undefined
    let calls = 0
    let refusal: LocalInferenceError | undefined
    const selected = terminal(
      (input, init) => {
        calls++
        return queue.fetch(fetch, input, init)
      },
      (err) => {
        if (!(err instanceof LocalInferenceError)) throw err
        refusal = err
      },
    )
    try {
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          return yield* executor.execute(HttpClientRequest.post(new URL("refused", host.url).href)).pipe(Effect.flip)
        }).pipe(
          Effect.provide(RequestExecutor.fetchLayer),
          Effect.provideService(FetchHttpClient.Fetch, Object.assign(selected, { preconnect: fetch.preconnect })),
        ),
      )
      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason._tag).toBe("InvalidRequest")
      expect(error.retryable).toBe(false)
      expect(error.retryAfterMs).toBeUndefined()
      expect(calls).toBe(1)
      expect(starts).toEqual(["/held"])
      expect(refusal).toBeInstanceOf(LocalInferenceError)
      if (!(refusal instanceof LocalInferenceError)) throw new Error("Native refusal identity was not retained")
      expect(refusal.code).toBe(code)
      const parsed = KiloSessionProcessor.parseError(refusal, {
        providerID: ProviderV2.ID.make("openai"),
        aborted: false,
      })
      expect(MessageV2.APIError.isInstance(parsed)).toBe(true)
      if (!MessageV2.APIError.isInstance(parsed)) throw new Error("Local refusal was not preserved as an API error")
      expect(parsed.data.isRetryable).toBe(false)
      expect(parsed.data.message).toBe(refusal.message)
      expect(parsed.data.metadata?.code).toBe(code)
      expect(SessionRetry.retryable(parsed)).toBeUndefined()
    } finally {
      abort.abort()
      await waiting
      stream?.close()
      await first.text()
      await host.stop(true)
    }
  })
}

test("native admission preserves genuine fetch failures and never records a local refusal for them", async () => {
  const failure = new Error("Owned network fixture failure")
  let recorded = false
  const selected = terminal(
    async () => {
      throw failure
    },
    () => {
      recorded = true
    },
  )
  expect(
    await selected("http://127.0.0.1/").then(
      () => undefined,
      (err: unknown) => err,
    ),
  ).toBe(failure)
  expect(recorded).toBe(false)
})
