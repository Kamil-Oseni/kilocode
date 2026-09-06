import { type Component, Show } from "solid-js"
import type { RunPresence } from "../../utils/run-presence"
import { presenceLabel } from "../../utils/run-presence"

export const PresenceBadge: Component<{
  state: RunPresence
  onAck?: () => void
}> = (props) => (
  <Show when={props.state !== "idle"}>
    <button
      type="button"
      class="presence-badge"
      data-presence={props.state}
      aria-label={presenceLabel(props.state)}
      onClick={() => {
        if (props.state === "waiting") window.dispatchEvent(new CustomEvent("showTaskStatus"))
        if (props.state === "done" || props.state === "error") props.onAck?.()
      }}
    >
      {presenceLabel(props.state)}
    </button>
  </Show>
)
