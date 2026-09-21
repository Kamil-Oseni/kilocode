import { describe, expect, test } from "bun:test"
import {
  messageInstant,
  messageLabel,
  messageTitle,
  timelineBreak,
  timelineLabel,
  ulidInstant,
} from "../../webview-ui/src/utils/message-time"

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

  test("groups a human timeline at meaningful conversation boundaries", () => {
    const first = messageInstant("2026-09-20T21:32:00.000Z")!
    const nearby = messageInstant("2026-09-20T21:51:00.000Z")!
    const later = messageInstant("2026-09-20T22:02:00.000Z")!
    const tomorrow = messageInstant("2026-09-21T00:02:00.000Z")!

    expect(timelineBreak(first)).toBe(true)
    expect(timelineBreak(nearby, first)).toBe(false)
    expect(timelineBreak(later, first)).toBe(true)
    expect(timelineBreak(tomorrow, later)).toBe(true)
    expect(timelineBreak(undefined, later)).toBe(false)
  })

  test("formats Codex-style localized timeline labels", () => {
    const now = new Date(2026, 8, 20, 22, 0)
    const today = new Date(2026, 8, 20, 21, 32)
    const yesterday = new Date(2026, 8, 19, 9, 5)
    const older = new Date(2026, 7, 14, 18, 45)

    expect(timelineLabel(today, now, "en-US")).toMatch(/^Today 9:32 PM$/)
    expect(timelineLabel(yesterday, now, "en-US")).toMatch(/^Yesterday 9:05 AM$/)
    expect(timelineLabel(older, now, "en-US")).toContain("Aug 14")
    expect(timelineLabel(undefined, now, "en-US")).toBe("")
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
