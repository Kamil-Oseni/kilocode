import { describe, expect, test } from "bun:test"
import { Clock, Deferred, Effect, Fiber, Schedule, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderCooldown } from "@/kilocode/provider/cooldown"
import { SessionRetry } from "@/session/retry"
import { it } from "../lib/effect"

function error(headers?: Record<string, string>) {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "Organization tokens per minute limit exceeded",
      isRetryable: true,
      statusCode: 429,
      responseHeaders: headers,
    }).toObject(),
  )
}

describe("Raya provider rate-limit queue", () => {
  test("preserves provider Retry-After windows longer than thirty seconds", () => {
    expect(SessionRetry.wait(1, error({ "retry-after": "90" }))).toBe(90_000)
    expect(SessionRetry.wait(1, error({ "retry-after-ms": "70000" }))).toBe(70_000)
  })

  test("waits for a full TPM window when the provider omits a retry hint", () => {
    expect(SessionRetry.wait(1, error())).toBe(60_000)
    expect(SessionRetry.wait(4, error())).toBe(60_000)
    expect(SessionRetry.wait(1, error({ "retry-after": "invalid" }))).toBe(60_000)
    expect(SessionRetry.wait(1, error({ "retry-after-ms": "-1" }))).toBe(60_000)
  })

  test("keeps ordinary provider retries on their existing backoff", () => {
    const ordinary = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({ message: "Provider unavailable", isRetryable: true, statusCode: 503 }).toObject(),
    )

    expect(SessionRetry.wait(1, ordinary)).toBe(2_000)
  })

  it.effect("shares a TPM cooldown with every session using the provider", () =>
    Effect.gen(function* () {
      const provider = "shared-provider"
      ProviderCooldown.clear(provider)
      const ready = yield* Deferred.make<void>()
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider,
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: () => Deferred.succeed(ready, undefined),
        }),
      )

      const fiber = yield* step(error()).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      const now = yield* Clock.currentTimeMillis
      expect(ProviderCooldown.remaining(provider, now)).toBe(60_000)
      expect(ProviderCooldown.remaining("other-provider", now)).toBe(0)
      yield* TestClock.adjust(60_000)
      yield* Fiber.join(fiber)
      ProviderCooldown.clear(provider)
    }),
  )
})
