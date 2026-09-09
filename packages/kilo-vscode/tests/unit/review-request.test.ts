import { describe, expect, test } from "bun:test"
import { reviewResult, retry } from "../../webview-ui/src/components/chat/review-request"

describe("chat review acknowledgement identity", () => {
  test("reuses a retry identity only for the same logical review action", () => {
    const previous = {
      request: "attempt-a",
      session: "a",
      key: "v1",
      epoch: 1,
      file: "a.ts",
      revision: "hash",
      action: "undo" as const,
    }
    expect(retry(previous, previous)).toBe("attempt-a")
    expect(retry(undefined, previous)).toBeUndefined()
    for (const change of [
      { session: "b" },
      { key: "v2" },
      { epoch: 2 },
      { file: "b.ts" },
      { revision: "other" },
      { action: "keep" as const },
    ]) {
      expect(retry(previous, { ...previous, ...change })).toBeUndefined()
    }
  })

  const pending = { request: "request-a", session: "session-a", key: "revision-a", epoch: 1 }
  const result = {
    type: "editReviewResult" as const,
    requestID: "request-a",
    sessionID: "session-a",
    action: "keep" as const,
  }
  const current = { session: "session-a", key: "revision-a", epoch: 1 }

  test("accepts only the matching successful action", () => {
    expect(reviewResult(pending, result, current)).toBe("accept")
    expect(reviewResult(pending, { ...result, refreshOnly: true }, current)).toBe("stale")
    expect(reviewResult(pending, { ...result, error: "Disconnected" }, current)).toBe("failed")
    expect(reviewResult(undefined, result, current)).toBe("ignore")
    expect(reviewResult(pending, { ...result, requestID: "request-b" }, current)).toBe("ignore")
    expect(reviewResult(pending, { ...result, sessionID: "session-b" }, current)).toBe("ignore")
  })

  test("a completed request cannot accept a newer revision, agent turn, or session", () => {
    expect(reviewResult(pending, result, { ...current, key: "revision-b" })).toBe("stale")
    expect(reviewResult(pending, result, { ...current, epoch: 2 })).toBe("stale")
    expect(reviewResult(pending, result, { ...current, session: "session-b" })).toBe("stale")
  })
})
