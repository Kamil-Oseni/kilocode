// raya_change - Milestone H plain-English voice control
import type { VoiceMode } from "../../../../src/shared/speech"

export function voiceIntent(text: string): VoiceMode | undefined {
  const value = text.trim().toLowerCase()
  if (/\b(turn|switch|start|enable).{0,20}(hands[- ]?free|continuous voice|voice conversation)\b/.test(value))
    return "hands-free"
  if (/\b(turn|switch|use|enable).{0,20}(push[- ]?to[- ]?talk|press to talk)\b/.test(value)) return "push-to-talk"
  if (/\b(stop|disable|turn off|exit).{0,20}(voice mode|hands[- ]?free|voice conversation)\b/.test(value)) return "off"
}

export function nextVoiceMode(mode: VoiceMode): VoiceMode {
  if (mode === "off") return "push-to-talk"
  if (mode === "push-to-talk") return "hands-free"
  return "off"
}
