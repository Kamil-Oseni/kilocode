import { describe, expect, test } from "bun:test"
import { messageInstant } from "../../webview-ui/src/utils/message-time"

describe("message time", () => {
  test("prefers the server message instant and accepts persisted legacy creation time", () => {
    expect(
      messageInstant({ time: { created: 1_789_430_400_000 }, createdAt: "2020-01-01T00:00:00.000Z" })?.toISOString(),
    ).toBe("2026-09-15T00:00:00.000Z")
    expect(messageInstant({ createdAt: "2026-09-14T16:00:00.000Z" })?.toISOString()).toBe("2026-09-14T16:00:00.000Z")
  })

  test("does not invent a timestamp for missing or malformed records", () => {
    expect(messageInstant()).toBeUndefined()
    expect(messageInstant({ createdAt: "not-a-date" })).toBeUndefined()
  })
})
