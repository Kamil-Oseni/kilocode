import { Show, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVoice } from "../../context/voice"
import { useServer } from "../../context/server"
import "./NativeVoiceRecovery.css"

export const NativeVoiceRecovery: Component = () => {
  const voice = useVoice()
  const server = useServer()
  return (
    <>
      <Show when={voice.settings().voiceEngine === "openai-realtime" && voice.status() === "off" && !voice.recovery()}>
        <div data-slot="native-voice-disclosure">
          <p>Starting voice shares recent saved task context with OpenAI. Unsaved spoken context may be missing.</p>
          <Show when={voice.startBlocked()}>
            <p role="status">Previous voice cleanup is still unconfirmed. Restart Raya if cleanup does not finish.</p>
          </Show>
        </div>
      </Show>
      <Show when={voice.settings().voiceEngine === "openai-realtime" && voice.recovery()}>
        {(recovery) => (
          <div data-slot="native-voice-recovery" role="group" aria-label="Restart voice">
            <p>
              A new voice call shares recent saved context from this task. Earlier spoken context may be missing. Work
              already started continues in this conversation.
            </p>
            <Show when={!recovery().ready}>
              <p role="status">
                {recovery().local === "failed" || recovery().host === "failed"
                  ? "Voice cleanup is unconfirmed. Restart Raya before trying voice again; review ongoing work here."
                  : "Waiting for microphone, audio, and provider cleanup before another voice call."}
              </p>
            </Show>
            <Button
              variant="secondary"
              size="small"
              disabled={!recovery().ready || !voice.settings().hasOpenAIKey || !server.isConnected()}
              onClick={voice.restart}
            >
              Restart voice in this task
            </Button>
          </div>
        )}
      </Show>
    </>
  )
}
