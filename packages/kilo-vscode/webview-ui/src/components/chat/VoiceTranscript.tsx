import { Show, type Component } from "solid-js"
import { useVoice } from "../../context/voice"

export const VoiceTranscript: Component = () => {
  const voice = useVoice()
  const transcript = voice.transcript
  const caption = () => {
    const value = transcript()
    if (!value) return
    if (value.limited)
      return "Transcript display limit reached. Voice continues; start a new voice call to reset the display."
    if (value.interruption === "confirmed")
      return `Speech interrupted. Provider confirmed an audio cutoff at ${value.audioEndMs} ms; heard words are unavailable.`
    if (value.interruption && value.generation === "failed")
      return "Voice response failed. Generated text is hidden because heard words are unavailable."
    if (value.interruption && value.generation === "incomplete")
      return "Voice response ended unfinished. Generated text is hidden because heard words are unavailable."
    if (value.interruption && value.generation === "cancelled")
      return "Voice response was cancelled. Generated text is hidden because heard words are unavailable."
    if (value.interruption) return "Speech interrupted. Heard words are unavailable; waiting for provider confirmation."
    if (value.direction === "output")
      return value.stable ? "Generated transcript (final text; playback unverified)" : "Generated transcript (partial)"
    if (value.direction === "input") return value.stable ? "Input transcript" : "Input transcript (partial)"
  }
  return (
    <Show when={voice.status() !== "off" || voice.error()}>
      <div
        class="prompt-realtime-voice"
        data-slot="voice-transcript"
        data-partial={transcript()?.stable === false && !transcript()?.interruption}
        role="status"
        aria-live="polite"
      >
        <span class="prompt-realtime-voice__state">
          {voice.status()}
          {voice.aec() ? " · AEC" : ""}
        </span>
        <Show when={caption()}>
          <span data-slot="voice-transcript-caption">{caption()}</span>
        </Show>
        <Show when={voice.error()}>
          <span class="prompt-realtime-voice__text">{voice.error()}</span>
        </Show>
        <Show when={!transcript()?.interruption && transcript()?.text}>
          <span class="prompt-realtime-voice__text">{transcript()?.text}</span>
        </Show>
        <Show when={transcript()?.truncated && !transcript()?.interruption}>
          <span data-slot="voice-transcript-caption">Display shortened to 8192 characters.</span>
        </Show>
      </div>
    </Show>
  )
}
