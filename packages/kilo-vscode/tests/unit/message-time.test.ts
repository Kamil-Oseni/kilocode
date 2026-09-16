import { describe, expect, test } from "bun:test"
import { messageInstant, messageLabel, messageTitle, ulidInstant } from "../../webview-ui/src/utils/message-time"

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

  test("decodes durable Messenger ULIDs and refuses malformed identities", () => {
    expect(ulidInstant("01ARZ3NDEKTSV4RRFFQ69G5FAV")?.toISOString()).toBe("2016-07-30T23:54:10.259Z")
    expect(ulidInstant("pending-message")).toBeUndefined()
    expect(ulidInstant("01ARZ3NDE!TSV4RRFFQ69G5FAV")).toBeUndefined()
    expect(ulidInstant("ZZZZZZZZZZTSV4RRFFQ69G5FAV")).toBeUndefined()
  })

  test("formats compact and complete labels from the same instant", () => {
    const date = messageInstant("2026-09-16T12:34:56.000Z")
    const short = messageLabel(date, "en-US")
    const full = messageTitle(date, "en-US")

    expect(short).toMatch(/\d{1,2}:34/)
    expect(full).toContain("2026")
    expect(messageLabel(undefined, "en-US")).toBe("")
    expect(messageTitle(undefined, "en-US")).toBe("")
  })

  test("binds the Messenger footer to one semantic instant", async () => {
    const source = await Bun.file(
      new URL("../../webview-ui/kiloclaw/components/MessageBubble.tsx", import.meta.url),
    ).text()

    expect(source).toContain("<time")
    expect(source).toContain('data-component="message-time"')
    expect(source).toContain("dateTime={value().toISOString()}")
    expect(source).toContain("title={full()}")
    expect(source).toContain("aria-label={full()}")
    expect(source).not.toContain("return Date.now()")
  })
})
