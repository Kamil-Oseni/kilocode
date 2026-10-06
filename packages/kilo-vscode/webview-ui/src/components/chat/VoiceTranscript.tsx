import { For, Show, type Component } from "solid-js"
import { useVoice } from "../../context/voice"
import { useSession } from "../../context/session"
import { activity } from "./activity-status"

export const VoiceTranscript: Component = () => {
  const voice = useVoice()
  const session = useSession()
  const transcript = voice.transcript
  const state = () =>
    activity({
      voice: voice.status(),
      error: voice.error(),
      busy: session.status() !== "idle",
      messages: session.visibleMessages(),
      tools: session.getSessionToolParts(session.currentSessionID() ?? ""),
      permission: session.scopedPermissions(session.currentSessionID()).length > 0,
      question: session.scopedQuestions(session.currentSessionID()).length > 0,
    })
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
      >
        <span class="prompt-realtime-voice__state" role="status" aria-live="polite" aria-atomic="true">
          {state()}
          {voice.aec() ? " · AEC" : ""}
        </span>
        <Show when={voice.live() && voice.captions()}>
          {(value) => (
            <div data-slot="live-transcript">
              <span>Live captions; generated words do not confirm audio playback.</span>
              <Show when={value().incomplete || value().limited}>
                <span role="status">
                  Caption coverage is incomplete{value().limited ? "; display limit reached" : ""}.
                </span>
              </Show>
              <Show when={value().fragments.length > 64}>
                <span>Showing the latest 64 caption fragments; this is not the full retained history.</span>
              </Show>
              <For each={value().fragments.slice(-64)}>
                {(fragment) => (
                  <div data-speaker={fragment.speaker}>
                    <strong>{fragment.speaker === "user" ? "You" : "Raya"}: </strong>
                    <span>{fragment.text}</span>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
        <Show when={!voice.live() && caption()}>
          <span data-slot="voice-transcript-caption">{caption()}</span>
        </Show>
        <Show when={voice.error()}>
          <span class="prompt-realtime-voice__text" role="alert">
            {voice.error()}
          </span>
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
