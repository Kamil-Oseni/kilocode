import { Show, type Component } from "solid-js"
import { useVoice } from "../../context/voice"
import "./NativeVoiceUsage.css"

export const NativeVoiceUsage: Component = () => {
  const voice = useVoice()
  return (
    <Show when={voice.usage()}>
      {(usage) => (
        <details data-slot="native-voice-usage">
          <summary>
            {usage().responses + usage().transcriptions === 0
              ? "Voice usage: awaiting provider reports"
              : usage().missing + usage().invalid === usage().responses + usage().transcriptions
                ? "Voice usage unavailable"
                : `Voice usage: ${usage().input.toLocaleString()} input / ${usage().output.toLocaleString()} output tokens reported${usage().seconds !== undefined ? `; ${usage().seconds!.toFixed(1)}s transcription` : ""}`}
          </summary>
          <p>
            Observed for this voice connection, with transcription tokens or duration recorded separately when reported.
            Work-model usage and invoice totals are separate.
          </p>
          <p>
            {usage().responses} response receipts · {usage().transcriptions} transcription receipts · {usage().recorded}{" "}
            saved
          </p>
          <Show when={usage().missing || usage().invalid || usage().pending}>
            <p>
              Usage unavailable for {usage().missing} receipts, invalid for {usage().invalid}, and pending for{" "}
              {usage().pending}. Unreported usage is not zero.
            </p>
          </Show>
          <Show when={usage().unrecorded || usage().incomplete}>
            <p role="status">
              The retained usage record is incomplete or still saving ({usage().unrecorded} unconfirmed). Check your
              provider for billing totals.
            </p>
          </Show>
          <p>No voice spending cap is enforced by this meter.</p>
        </details>
      )}
    </Show>
  )
}
