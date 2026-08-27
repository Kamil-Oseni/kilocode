// raya_change - Executable and testable realtime → cascade → text degradation policy.
import type { SpeechState } from "../shared/speech"

export type VoiceFallback = "cascade-v1" | "text"

export function voiceFallback(settings: SpeechState): VoiceFallback {
  if (settings.sttEndpoint && settings.hasSttKey && settings.hasTtsKey) return "cascade-v1"
  return "text"
}
