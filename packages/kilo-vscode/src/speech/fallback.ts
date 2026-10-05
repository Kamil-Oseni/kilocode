// raya_change - Executable and testable realtime → cascade → text degradation policy.
import type { SpeechState } from "../shared/speech"

export type VoiceFallback = "cascade-v1" | "text"

export function voiceFallback(settings: SpeechState): VoiceFallback {
  const key =
    settings.ttsEngine === "local-jobs"
      ? settings.hasLocalKey
      : settings.ttsEngine === undefined || settings.ttsEngine === "minimax"
        ? settings.hasTtsKey
        : false
  if (settings.sttEndpoint && settings.hasSttKey && key) return "cascade-v1"
  return "text"
}
