import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionRetry } from "@/session/retry"

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
})
