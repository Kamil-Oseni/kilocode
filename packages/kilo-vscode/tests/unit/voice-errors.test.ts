import { describe, expect, it } from "bun:test"
import { capture, MicrophoneError } from "../../webview-ui/src/context/voice-errors"

describe("safe microphone guidance", () => {
  it("classifies actual capture exceptions without disclosing their message", () => {
    for (const name of [
      "NotAllowedError",
      "SecurityError",
      "NotFoundError",
      "OverconstrainedError",
      "NotReadableError",
      "AbortError",
    ]) {
      const text = capture(new DOMException("private-device-token", name))
      expect(text).toContain("microphone")
      expect(text).toContain("reconnect or continue typing")
      expect(text).not.toContain("private-device-token")
    }
    expect(capture(new DOMException("private", "NotAllowedError"))).toContain("Allow microphone access")
    expect(capture(new DOMException("private", "NotFoundError"))).toContain("Connect or select one")
    expect(capture(new DOMException("private", "NotReadableError"))).toContain("Close other apps")
  })

  it("keeps unknown connection failures and serialized objects outside microphone classification", () => {
    expect(capture(new Error("provider credential private-token"))).toBeUndefined()
    expect(capture({ name: "NotAllowedError", message: "private-token" })).toBeUndefined()
    expect(capture(null)).toBeUndefined()
  })

  it("gives missing-publication guidance without exposing a device identifier", () => {
    const err = new Error("private-device-id")
    err.name = "MicrophoneUnavailableError"
    expect(capture(err)).toBe(
      "Your microphone is unavailable. Check your input device, then reconnect or continue typing.",
    )
  })

  it("tags only safe capture guidance and retains no raw exception cause", () => {
    const raw = new DOMException("private-device-token", "NotAllowedError")
    const err = new MicrophoneError(raw)
    expect(err.message).toContain("Allow microphone access")
    expect(err.message).not.toContain("private-device-token")
    expect(err.cause).toBeUndefined()
    expect(raw instanceof MicrophoneError).toBe(false)
    expect(new MicrophoneError().message).toContain("microphone is unavailable")
    expect(new MicrophoneError(new Error("private-provider-token")).message).not.toContain("private-provider-token")
  })
})
