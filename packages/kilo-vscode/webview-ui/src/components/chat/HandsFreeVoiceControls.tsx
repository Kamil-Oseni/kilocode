import { Show, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVoice } from "../../context/voice"

export const HandsFreeVoiceControls: Component<{ end: () => void }> = (props) => {
  const voice = useVoice()
  return (
    <Show
      when={
        !["openai-realtime", "openai-live"].includes(voice.settings().voiceEngine) &&
        voice.settings().mode === "hands-free" &&
        voice.status() !== "off"
      }
    >
      <div data-slot="hands-free-voice-controls" role="group" aria-label="Hands-free voice controls">
        <span role="status">
          {voice.status() === "degraded" ? "Hands-free voice paused" : "Hands-free voice active"}
        </span>
        <Button variant="ghost" size="small" aria-label="Stop hands-free listening" onClick={props.end}>
          Stop hands-free listening
        </Button>
      </div>
    </Show>
  )
}
