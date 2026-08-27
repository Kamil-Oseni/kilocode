// raya_change - All three voice failure rungs remain explicit and user-visible.
import { describe, expect, it } from "bun:test"
import { voiceFallback } from "../../src/speech/fallback"
import { DEFAULT_SPEECH_SETTINGS } from "../../src/shared/speech"

describe("voice failure ladder", () => {
  it("demotes native realtime failure to the configured cascade", () => {
    expect(
      voiceFallback({
        ...DEFAULT_SPEECH_SETTINGS,
        sttEndpoint: "https://example.test/v1/audio/transcriptions",
        hasRealtimeKey: true,
        hasSttKey: true,
        hasTtsKey: true,
      }),
    ).toBe("cascade-v1")
  })

  it("demotes an unavailable cascade to text instead of silence", () => {
    expect(
      voiceFallback({
        ...DEFAULT_SPEECH_SETTINGS,
        hasRealtimeKey: false,
        hasSttKey: false,
        hasTtsKey: false,
      }),
    ).toBe("text")
  })
})
