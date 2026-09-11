import { Show, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { NativeVoiceImage } from "./NativeVoiceImage"
import { useVoice } from "../../context/voice"

export const NativeVoiceControls: Component<{ end: () => void }> = (props) => {
  const voice = useVoice()
  const connected = () => voice.status() === "listening" || voice.status() === "speaking"
  return (
    <Show when={["openai-realtime", "openai-live"].includes(voice.settings().voiceEngine) && voice.status() !== "off" && !voice.recovery()}>
      <div data-slot="native-voice-controls" role="group" aria-label="Voice controls">
        <span role="status">
          {voice.muted()
            ? "Microphone muted"
            : voice.status() === "connecting"
              ? "Connecting voice"
              : voice.status() === "degraded"
                ? "Voice needs attention"
                : "Voice connected"}
        </span>
        <Button variant="ghost" size="small" disabled={!connected()} aria-pressed={voice.muted()} onClick={voice.mute}>
          {voice.muted() ? "Unmute microphone" : "Mute microphone"}
        </Button>
        <Button variant="ghost" size="small" disabled={voice.live() ? !connected() || voice.silenced() : voice.status() !== "speaking"} onClick={voice.interrupt}>
          Stop speaking
        </Button>
        <Show when={voice.live() && voice.silenced()}>
          <span role="status">Voice audio muted. Work continues.</span>
          <Button variant="ghost" size="small" onClick={voice.resume}>Resume voice audio</Button>
        </Show>
        <Button variant="ghost" size="small" onClick={props.end}>
          End voice
        </Button>
        <NativeVoiceImage />
      </div>
    </Show>
  )
}
